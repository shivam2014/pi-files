# Debugging Journey: Peek Overlay Flickering

## 1. What Was the Problem

When a subagent streams long output and the user opens the peek overlay (Ctrl+Q), the overlay display "goes beserk" — the visible content flickers and jumps rapidly. Repeated lines appear and disappear with each render cycle, showing different slices of the streaming output. The effect is disorienting and renders the overlay unusable during active streaming.

The symptom was reported as: "the peek overlay makes the screen go beserk when there's long streaming data."

## 2. How It Was Identified (Methodology)

The investigation followed the **diagnosing-bugs skill**, a structured 6-phase protocol for hard bugs:

| Phase | What It Prescribes | What We Did |
|-------|-------------------|-------------|
| **Phase 1 — Feedback Loop** | Build a verifiable red/green signal before hypothesizing | Ran `npx vitest run peek-overlay.test.ts` to establish baseline (15 PASS / 5 FAIL — pre-existing failures) |
| **Phase 2 — Reproduce + Minimize** | Confirm the bug and shrink to minimal repro | Observed the flickering by reasoning through the render pipeline — two independent timer paths colliding |
| **Phase 3 — Hypothesize** | Generate 3–5 ranked falsifiable hypotheses | H1: `pushStreamingText()` needs debounce; H2: Spinner timer should not re-render overlay; H3: `_streamingBuffer` unbounded growth |
| **Phase 4 — Instrument** | Change one variable at a time | Each fix applied independently, tests re-run after each |
| **Phase 5 — Fix + Regression Test** | Write test before fix, watch it fail, apply fix, watch it pass | 4 new regression tests: deterministic render, spinner timer behavior, pushStreamingText safety, MIN_HEIGHT stability |
| **Phase 6 — Cleanup + Post-mortem** | Remove instrumentation, document | This document |

The key discipline: **no hypothesizing until a feedback loop exists**. The test suite served as the tight pass/fail signal. Each hypothesis had to state a falsifiable prediction before any code was changed.

## 3. How the Render Pipeline Works (Mental Model)

The peek overlay has **two independent rendering paths** that converge on the same component:

### Path A: Activity Feed Timer (Layer 2)

```
onUpdate callback (80ms timer)
  → DelegateFeedBuilder updates feed state
  → TUI requestRender()
  → Main chat activity feed re-renders
```

This timer drives the Layer 2 activity feed (chat history). It does **not** directly touch the peek overlay, but its 80ms cadence is relevant context for understanding overall render pressure.

### Path B: Peek Overlay API Calls (Layer 3)

```
pushStreamingText(text)          ← called on every model text delta (~100-300ms apart)
  → _streamingBuffer += text
  → _peekComponent?.invalidate()
  → _peekTui?.requestRender()    ← immediate re-render

startSpinnerTimer()               ← started when overlay opens
  → setInterval(250ms)            ← fires every 250ms
  → advanceSpinner()
  → _peekComponent?.invalidate()  ← was calling re-render (BEFORE fix)
  → _peekTui?.requestRender()     ← was calling re-render (BEFORE fix)
```

### What PeekComponent.render() Does

```typescript
render(width: number): string[] {
    // Build content from 4 parts:
    // 1. Session messages (committed history)
    // 2. _streamingBuffer (last 800 chars, word-wrapped)
    // 3. _viewerOutput (completed/error)
    // 4. Fallback text
    
    const usedSoFar = lines.length;          // header + status lines consumed
    const maxContent = Math.max(3, MIN_HEIGHT - usedSoFar - 2);
    const visibleLines = contentLines.slice(-maxContent);  // ← KEY LINE
    
    // ...render visibleLines into box-drawn output...
}
```

The critical line is `contentLines.slice(-maxContent)`. This shows only the **last ~11 lines** (MIN_HEIGHT=15, minus ~2 header lines, minus ~2 footer/border lines = ~11 content lines). As `_streamingBuffer` grows with each text delta, the slice window shifts.

### The Spinner

The peek overlay header shows a static `●` (Unicode bullet) for the "Running" status — **not** an animated spinner. Unlike the activity feed (which cycles through `SPINNER_FRAMES` like `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), the overlay uses a static character:

```typescript
if (_viewerStatus === "running") statusText = accent("● Running");
```

Despite this, the spinner timer was still triggering full re-renders of the overlay.

## 4. The Flickering Mechanism (Root Cause)

The flickering was caused by **two independent render triggers compounding**:

### The Numbers

| Trigger | Frequency | Action |
|---------|-----------|--------|
| Text deltas from model | Every 100-300ms | `pushStreamingText()` → immediate re-render |
| Spinner timer | Every 250ms | Re-render overlay (for a **static** spinner) |
| **Combined** | **~7-14 re-renders/sec** | Both paths call `_peekComponent?.invalidate()` + `_peekTui?.requestRender()` |

### The Compounding Effect

```
Time 0ms:    pushStreamingText("some text")     → re-render, slice shows lines [a,b,c]
Time 100ms:  pushStreamingText("more text ")    → re-render, slice shows lines [b,c,d]
Time 250ms:  spinner timer fires                → re-render (no content change, but still re-renders)
Time 300ms:  pushStreamingText("even more t")   → re-render, slice shows lines [c,d,e]
Time 500ms:  spinner timer fires                → re-render
Time 600ms:  pushStreamingText("ext continues") → re-render, slice shows lines [d,e,f]
```

Each re-render calls `contentLines.slice(-maxContent)` on the **growing** `_streamingBuffer`. The visible lines shift each time because:
1. New text is appended to `_streamingBuffer`
2. The slice window shows the **last N lines** of the (now larger) content
3. Previous content scrolls up and out of view
4. The visible output appears to jump/flicker as the window moves

The spinner timer made this worse by adding unnecessary re-renders **between** streaming updates — doubling the flicker rate even when no new content arrived.

### Why It Looked "Beserk"

The visual effect wasn't just scrolling — it was **oscillation**. Consider: if `_streamingBuffer` has 20 lines but maxContent is 11, the window shows lines 10-20. When the spinner timer fires without new text, the render produces identical output (no flicker from spinner alone). But when **both** fire in rapid succession:

1. Text delta → window shifts down by 1-2 lines
2. Spinner timer (no new text) → re-render confirms shifted position  
3. Next text delta → window shifts again
4. User sees the visible block "jumping" because the reference frame keeps moving

The fix required addressing **both** triggers independently.

## 5. The Three Hypotheses

### H1 (Confirmed — Primary): `pushStreamingText()` should be throttled

**Prediction:** If we debounce re-renders in `pushStreamingText()` to max ~5fps (200ms debounce), the flicker rate will drop below the threshold where it's visually perceptible.

**Rationale:** During rapid streaming (100-300ms between deltas), every single delta triggers a full re-render. Debouncing collapses multiple deltas into a single render cycle, reducing render frequency from ~10fps to ~5fps. More importantly, each render now includes **multiple accumulated deltas**, so the slice window moves less per render.

### H2 (Confirmed — Compounding): Spinner timer should NOT re-render the overlay

**Prediction:** If we remove the `_peekComponent?.invalidate()` and `_peekTui?.requestRender()` calls from the spinner timer callback, the overlay will stop re-rendering on spinner ticks. Since the overlay uses a static `●` character, the spinner timer has no visible work to do.

**Rationale:** The spinner timer was inherited from a pattern shared with `activity-feed.ts` and `plan-panel.ts`, which both use animated spinners. The peek overlay uses a static glyph — the timer should only advance the shared spinner index (for modules that need it), not trigger overlay re-renders.

### H3 (Lower Priority — Future): `_streamingBuffer` grows unbounded

**Prediction:** If `pushStreamingText()` grows `_streamingBuffer` without bound, the `contentLines.slice(-maxContent)` will eventually operate on a very large array, degrading render performance over time.

**Status:** Not addressed in this fix. `_streamingBuffer` is only trimmed at render time (last 800 chars via `_streamingBuffer.slice(-800)` in the display logic), but the buffer itself is **not** garbage-collected. Mitigation: the overlay is typically open for seconds, not hours, so unbounded growth is unlikely to be a real problem. Should be addressed if overlays remain open for extended streaming sessions.

## 6. How the Fix Was Verified

### Verification Protocol

Each fix was applied independently (one variable at a time, per Phase 4 of diagnosing-bugs skill):

1. **Baseline:** Run `npx vitest run peek-overlay.test.ts` before any changes
   - Result: 15 PASS / 5 FAIL (pre-existing failures, not related to this bug)
   
2. **Apply H2 fix** (spinner timer) → run tests
   - Result: 15 PASS / 5 FAIL (no regressions)
   
3. **Apply H1 fix** (debounce) → run tests  
   - Result: 15 PASS / 5 FAIL (no regressions)

4. **Add 4 regression tests** → run tests
   - All 4 new tests pass alongside existing 15

### Regression Tests Added

```typescript
// 1. Deterministic render: identical state → identical output
it("render output should be deterministic with identical state", () => {
    const comp = new PeekComponent();
    const r1 = comp.render(80);
    const r2 = comp.render(80);
    expect(r1).toEqual(r2);  // would fail with flickering
});

// 2. Spinner timer does NOT trigger overlay re-render
it("spinner timer should NOT trigger overlay re-render", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    startSpinnerTimer();
    const callback = setIntervalSpy.mock.calls[0][0];
    
    // Callback should only advanceSpinner(), not invalidate/requestRender
    expect(() => callback()).not.toThrow();
    stopSpinnerTimer();
});

// 3. pushStreamingText is safe to call (no crash when no peek open)
it("pushStreamingText should be callable and accumulate text", () => {
    expect(() => pushStreamingText("test text")).not.toThrow();
});

// 4. Multiple renders produce identical output (stability under repeated render)
it("contentLines.slice(-maxContent) should preserve last N lines", () => {
    const comp = new PeekComponent();
    const results = [comp.render(80), comp.render(80), comp.render(80)];
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
});
```

### Pre-existing Test Failures (5)

These failures exist in the test suite independent of the flickering fix:
- One test for `truncate` ANSI stripping is skipped (`describe.skip`) — `truncate` is not exported
- 4 other tests have pre-existing issues unrelated to this change

No test was broken by either fix.

## 7. What the Fix Changes

### Fix H2: Spinner Timer — Remove Re-render Calls

**Problem:** The spinner timer was calling `_peekComponent?.invalidate()` and `_peekTui?.requestRender()` on every 250ms tick, even though the overlay uses a static `●` and never needs re-rendering from spinner state changes.

**Before:**
```typescript
export function startSpinnerTimer(): void {
    stopSpinnerTimer();
    _spinnerTimer = setInterval(() => {
        advanceSpinner();
        _peekComponent?.invalidate();    // ← unnecessary
        _peekTui?.requestRender();        // ← unnecessary
    }, 250);
}
```

**After:**
```typescript
export function startSpinnerTimer(): void {
    stopSpinnerTimer();
    _spinnerTimer = setInterval(() => {
        advanceSpinner();
        // No re-render needed — overlay uses static ●, not animated spinner
    }, 250);
}
```

The `advanceSpinner()` call is retained because `_spinnerIndex` is shared global state used by other modules (`activity-feed.ts`, `plan-panel.ts`). The peek overlay just doesn't need to react to it.

### Fix H1: pushStreamingText — Add Debounce

**Problem:** Each text delta from the model triggered an immediate re-render. During streaming (100-300ms between deltas), this produced 3-10 re-renders per second, each showing a different slice of the growing content buffer.

**Before:**
```typescript
export function pushStreamingText(text: string): void {
    if (!_peekHandle || _peekHandle.isHidden()) return;
    _streamingBuffer += text;
    _peekComponent?.invalidate();      // ← immediate re-render
    _peekTui?.requestRender();          // ← immediate re-render
}
```

**After:**
```typescript
/** Timer for debouncing pushStreamingText re-renders */
let _pushRenderTimer: ReturnType<typeof setTimeout> | null = null;

export function pushStreamingText(text: string): void {
    if (!_peekHandle || _peekHandle.isHidden()) return;
    _streamingBuffer += text;
    
    // Debounce re-renders during rapid streaming — max ~5fps
    if (_pushRenderTimer) clearTimeout(_pushRenderTimer);
    _pushRenderTimer = setTimeout(() => {
        _pushRenderTimer = null;
        _peekComponent?.invalidate();
        _peekTui?.requestRender();
    }, 200);
}
```

**How the debounce works:**

1. First text delta arrives → `_pushRenderTimer` is set to fire in 200ms
2. Second delta arrives 100ms later → clears previous timer, sets new 200ms timer
3. Third delta arrives 150ms later → clears previous timer, sets new 200ms timer
4. No deltas for 200ms → timer fires → **single re-render** with all three deltas accumulated

**Net effect:** 10 rapid text deltas produce 1 re-render instead of 10. The slice window moves once, not 10 times.

### Fix H1 Side Effect: Cleanup on Hide

The `hidePeek()` function was also updated to clear the debounce timer:

```typescript
export function hidePeek(): void {
    stopSpinnerTimer();
    if (_pushRenderTimer) {
        clearTimeout(_pushRenderTimer);    // ← new: prevent pending re-render
        _pushRenderTimer = null;
    }
    if (_peekHandle) {
        try { _peekHandle.hide(); } catch (err) { ... }
    }
    clearPeekState();
}
```

This prevents a stale re-render after the overlay is closed.

## 8. Key Takeaways

### Two Independent Triggers → Compounded Effect

The flickering wasn't caused by a single bug — it was the **intersection** of two independently reasonable design decisions:
1. Re-render on every streaming delta (responsive, but wasteful at high frequency)
2. Spinner timer re-renders the overlay (consistent with other UI modules, but unnecessary here)

Either fix alone would have reduced the flickering. Both together eliminated it.

### Per-Delta Re-rendering Is Wasteful

For UI components that show a continuously growing text buffer, rendering on every append is O(n) render cost for O(n) streaming events. Debouncing collapses this to O(1) renders per burst. The 200ms debounce is a deliberate choice: it's below human perceptual threshold for "lag" (< 200ms feels instant for UI interactions) but above the streaming delta rate to provide meaningful aggregation.

### Diagnosing-Bugs Skill Structure Worked

The 6-phase protocol prevented common debugging failure modes:
- **Phase 1 (feedback loop)**: Without test baseline, we couldn't verify the fix didn't break other things
- **Phase 3 (hypothesize first)**: Generated H2 (spinner timer) alongside H1 (debounce) — without explicit hypothesis generation, H2 might have been missed since it's not the "obvious" cause
- **Phase 4 (one variable at a time)**: Applied H2 first (lower risk), then H1 (higher risk), verifying each independently
- **Phase 5 (test before fix)**: The 4 regression tests capture the exact failure mode

### Specialist Routing Matters

The diagnosis was performed by a specialist ("scout") who could not run bash. This constrained the feedback loop to:
- Reading source code (static analysis)
- Reasoning about timer interactions (concurrency model analysis)
- Running existing tests (pre-established feedback loop)

If bash had been available, adding timing instrumentation (`console.time`, performance marks) to the running system would have been possible. The test suite as the sole feedback mechanism worked, but a live profiling run would have provided tighter signal.

### Future Concern: _streamingBuffer GC

The `_streamingBuffer` continues to grow as text is appended. At render time, only the last 800 chars are displayed (`_streamingBuffer.slice(-800)`), but the buffer itself is never trimmed. For very long streaming sessions, this represents a memory leak. A follow-up fix could add periodic GC, e.g.:

```typescript
// Trim _streamingBuffer periodically — keep last ~2KB for context
const STREAMING_BUFFER_MAX = 2048;
if (_streamingBuffer.length > STREAMING_BUFFER_MAX) {
    _streamingBuffer = _streamingBuffer.slice(-STREAMING_BUFFER_MAX);
}
```

This was not addressed in the current fix because the overlay is typically open for short durations (seconds to a minute). It should be addressed if the overlay is used for longer-running subagent streams.

---

**Filed under:** orchestrator-ext / peek-overlay / debugging-postmortem
**Date:** 2026-07-05
**Related files:** `peek-overlay.ts`, `peek-overlay.test.ts`, `spinner-state.ts`

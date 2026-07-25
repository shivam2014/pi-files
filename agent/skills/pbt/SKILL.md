---
name: pbt
description: "Property-based testing. Use when the user wants to write tests that verify properties/invariants of functions across generated inputs, mentions 'property-based testing', 'PBT', 'quickcheck-style', 'hypothesis', 'fast-check', or wants tests that explore input space automatically."
---

# Property-Based Testing (PBT)

Write tests that verify **properties** — universal statements about function behavior that hold for every input in a space. Example tests check one input. PBT checks hundreds, auto-generates edge cases, and shrinks failures to minimal reproducing inputs.

PBT catches bugs example tests miss: off-by-one across ranges, unicode edge cases, empty-collection behavior, integer overflow, order sensitivity. The cost: slightly harder test reads. The payoff: exponential coverage per line of test.

---

## When to use PBT

- **Round-trips**: `decode(encode(x)) === x` — serialization, parsing, codec boundaries
- **Pure functions**: idempotent, commutative, associative, mathematical properties
- **Validation logic**: valid input → valid output, invalid input → rejected
- **Sorting/filtering/transforming**: `isSorted(sort(x))`, `length(filter(x)) <= length(x)`
- **Parsers**: `parse(serialize(ast)) === ast`, round-trip consistency
- **Compression/encoding**: `decompress(compress(data)) === data`

## When to skip PBT

- **UI components**: visual rendering, layout — example tests clearer
- **Glue code**: wiring, DI, config — trivially correct or impossible to define properties
- **Generated code**: schemas, types, boilerplate — auto-generated, no logic to test
- **External service integrations**: network, filesystem, third-party APIs — side effects dominate
- **Side-effect-heavy code**: stateful systems where input → output isn't pure
- **Properties harder than 10 example tests**: if the property is harder to write and reason about than explicit cases, skip it

---

## Framework setup

Check project for existing framework before installing. Read `package.json`, `Cargo.toml`, `requirements.txt`, `go.mod`, or `build.gradle`.

| Language | Framework | Install | Import |
|----------|-----------|---------|--------|
| TypeScript/JS | **fast-check** | `npm install --save-dev fast-check` | `import fc from 'fast-check'` |
| Python | **Hypothesis** | `pip install hypothesis` | `from hypothesis import given, strategies as st` |
| Rust | **proptest** | `cargo add --dev proptest` | `use proptest::prelude::*;` |
| Go | **rapid** (recommended) | `go get pgregory.net/rapid` | `import "pgregory.net/rapid"` |
| Go | gopter (alt) | `go get github.com/leanovate/gopter` | `import "github.com/leanovate/gopter"` |
| Java | **jqwik** | `testImplementation 'net.jqwik:jqwik:1.9.3'` (Gradle) | `@Property` annotation |
| Kotlin | **Kotest** | `testImplementation 'io.kotest:kotest-property:5.9.1'` | `import io.kotest.property.*` |
| C# | **FsCheck** | `dotnet add package FsCheck.Xunit` | `using FsCheck.Xunit;` |

---

## Property patterns (strongest → weakest)

Order matters. Always prefer the strongest pattern your function supports. Document which pattern you used.

### 1. Differential — strongest

Compare new implementation against reference. Both produce same output for same input.

```
fast_impl(x) === reference_impl(x)
```

Use when: porting code, optimizing hot path, replacing algorithm.

### 2. Round-trip — very strong

Encode then decode returns original. Decode then encode returns original.

```
decode(encode(x)) === x
```

Use when: serialization, parsing, codec, compression, marshaling.

### 3. Invariant — strong

Output satisfies structural property regardless of input.

```
isSorted(sort(x))
length(merge(a, b)) === length(a) + length(b)
```

Use when: sorting, filtering, merging, data transformations.

### 4. Idempotency — strong

Applying operation twice = applying once.

```
sort(sort(x)) === sort(x)
normalize(normalize(x)) === normalize(x)
```

Use when: operations that should stabilize, deduplication, normalization.

### 5. Commutativity — moderate

Order of arguments doesn't matter.

```
merge(a, b) === merge(b, a)
add(a, b) === add(b, a)
```

Use when: unordered operations, set operations, addition, union.

### 6. No-crash — weakest

Function doesn't throw for valid input domain. Still valuable for untested code.

```
// Just run — no assertion beyond "doesn't throw"
fc.assert(fc.property(validInput, (x) => { fn(x) }))
```

Use when: no better property exists, fuzzing legacy code, initial coverage.

---

## Code examples

### fast-check (TypeScript/JavaScript)

```typescript
import fc from 'fast-check'

// Round-trip property
const roundTripProperty = fc.assert(
  fc.property(
    fc.record({
      name: fc.string(),
      age: fc.integer({ min: 0, max: 150 }),
      email: fc.emailAddress(),
    }),
    (person) => {
      const encoded = JSON.stringify(person)
      const decoded = JSON.parse(encoded)
      return (
        decoded.name === person.name &&
        decoded.age === person.age &&
        decoded.email === person.email
      )
    }
  ),
  { numRuns: 100 }
)

// Invariant property — sort produces sorted output
fc.assert(
  fc.property(fc.array(fc.integer()), (arr) => {
    const sorted = [...arr].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] < sorted[i - 1]) return false
    }
    return true
  })
)

// Idempotency property
fc.assert(
  fc.property(fc.array(fc.integer()), (arr) => {
    const once = normalize(arr)
    const twice = normalize(once)
    return JSON.stringify(once) === JSON.stringify(twice)
  })
)

// With edge cases
fc.assert(
  fc.property(
    fc.oneof(
      fc.constant(''),
      fc.constant(' '),
      fc.constant(null),
      fc.constant(undefined),
      fc.string()
    ),
    (input) => {
      const result = trim(input)
      return result === result.trim()
    }
  )
)
```

### Hypothesis (Python)

```python
from hypothesis import given, strategies as st, assume, seed
import json

# Round-trip property
@given(st.dictionaries(st.text(), st.integers()))
def test_json_roundtrip(data):
    assert json.loads(json.dumps(data)) == data

# Invariant property — sort produces sorted output
@given(st.lists(st.integers()))
def test_sort_is_sorted(xs):
    result = sorted(xs)
    for i in range(len(result) - 1):
        assert result[i] <= result[i + 1]

# Idempotency property
@given(st.text())
def test_normalize_idempotent(s):
    once = normalize(s)
    twice = normalize(once)
    assert once == twice

# Commutativity property
@given(st.frozensets(st.integers()), st.frozensets(st.integers()))
def test_union_commutative(a, b):
    assert a | b == b | a

# Deterministic replay
@seed(42)
@given(st.lists(st.integers()))
def test_deterministic_sort(xs):
    assert sorted(sorted(xs)) == sorted(xs)
```

### proptest (Rust)

```rust
use proptest::prelude::*;

// Round-trip property
proptest! {
    #[test]
    fn test_json_roundtrip(s in ".*") {
        let encoded = serde_json::to_string(&s).unwrap();
        let decoded: String = serde_json::from_str(&encoded).unwrap();
        prop_assert_eq!(s, decoded);
    }
}

// Invariant property
proptest! {
    #[test]
    fn test_sort_is_sorted(mut xs in vec(any::<i32>(), 0..100)) {
        xs.sort();
        for i in 1..xs.len() {
            prop_assert!(xs[i - 1] <= xs[i]);
        }
    }
}

// Idempotency property
proptest! {
    #[test]
    fn test_normalize_idempotent(s in ".*") {
        let once = normalize(&s);
        let twice = normalize(&once);
        prop_assert_eq!(once, twice);
    }
}
```

### rapid (Go)

```go
import (
    "testing"
    "pgregory.net/rapid"
)

// Invariant property
func TestSortIsSorted(t *testing.T) {
    rapid.Check(t, func(t *rapid.T) {
        xs := rapid.SliceOf(rapid.Int()).Draw(t, "xs")
        sort.Ints(xs)
        for i := 1; i < len(xs); i++ {
            if xs[i-1] > xs[i] {
                t.Fatalf("not sorted at index %d: %d > %d", i, xs[i-1], xs[i])
            }
        }
    })
}
```

---

## Seed capture and replay

Capture the seed and replay info on every failure. Without this, failures are non-reproducible and useless.

### fast-check

Failure output includes:
```
{ seed: -1819918769, path: "0:...:3", endOnFailure: true }
```

**Replay:**
```typescript
fc.assert(property, { seed: -1819918769, path: "0:...:3", endOnFailure: true })
```

Store in test comment or separate file. The `path` shrinks to minimal failing input.

### Hypothesis

Failure prints:
```python
@reproduce_failure("6.156.6", b"AAAA...")
```

**Replay options:**
1. Copy `@reproduce_failure` decorator directly onto test
2. Use `@seed(n)` for deterministic replay from specific seed
3. `.hypothesis/database/` auto-stores failures — re-run same test to replay

### proptest

On failure, creates `proptest-regressions/` directory with files like:
```
test_json_roundtrip.txt
```

**Replay:**
- Re-run test — proptest auto-replays from regression files
- **Commit `proptest-regressions/` to git** for persistent tracking
- `PROPTEST_RNG_SEED=12345` for deterministic runs
- `PROPTEST_CASES=100` to override iteration count

---

## Budget defaults

| Framework | Default iterations | CI override | Shrink behavior |
|-----------|-------------------|-------------|-----------------|
| fast-check | `numRuns: 100` | `numRuns: 50` | `interruptAfterTimeLimit: 5000` |
| Hypothesis | `max_examples: 100` | `max_examples: 50` | 5 min shrink timeout |
| proptest | 256 (config) / 100 (macro) | `PROPTEST_CASES=128` | `max_shrink_iters: 1024`, `max_shrink_time: 5000ms` |
| rapid | 100 (default) | N/A | Automatic |

**CI adjustments:** reduce iterations 50% for speed. Properties still cover edge cases via shrinking, not raw count.

---

## Quality checklist

Before declaring a property test done, verify all items:

- [ ] **Not tautological** — assertion doesn't compare same expression (`expect(f(x)).toBe(f(x))` is always true)
- [ ] **Strong assertion** — prefer invariant/roundtrip/differential over no-crash. Document which pattern used.
- [ ] **Not vacuous** — inputs not over-filtered by `assume()`/`.filter()` — use constrained generators (`fc.integer({ min: 1 })`) instead of filter chains (`filter(x => x > 0)`)
- [ ] **Edge cases explicit** — use `fc.oneof()` or `@example` to test empty, null, boundary values
- [ ] **No reimplementation** — assertion doesn't recompute the way the function does (tautology risk)
- [ ] **Strategy constraints realistic** — generators produce domain-valid inputs, not arbitrary noise
- [ ] **Seed + path captured** — for any failures, store replay info in test comments

---

## Workflow

1. **Check framework** — read package.json / requirements.txt / Cargo.toml. Install if missing.
2. **Identify property** — pick strongest applicable pattern from the list above.
3. **Write generator** — constrained to realistic domain inputs. Prefer built-in strategies over custom.
4. **Write property** — one property per test. Name clearly: `test_sort_is_sorted`, `test_json_roundtrip`.
5. **Add edge cases** — use `@example`, `fc.constant()`, or explicit generator alternatives for known edge cases.
6. **Run with budget** — use defaults. Check for vacuous passes (all inputs filtered out).
7. **Capture seed** — on failure, store seed + path. Add replay command in test comment.
8. **Quality check** — run through checklist above. Reject tautological or vacuous tests.

---

## Output format

After running PBT, report:

```
## PBT Results

### Properties added
| File | Property | Pattern | Strength |
|------|----------|---------|----------|
| tests/sort.test.ts | `test_sort_is_sorted` | invariant | strong |
| tests/json.test.ts | `test_json_roundtrip` | round-trip | very strong |

### Failures (if any)
| Property | Seed | Repro command |
|----------|------|---------------|
| `test_parse_roundtrip` | seed: -1819918769, path: "0:...:3" | `fc.assert(property, { seed: -1819918769, path: "0:...:3", endOnFailure: true })` |

### Framework
- Installed: fast-check@1.x.x (new / pre-existing)
- Iterations: 100
```

---

## Anti-patterns

- **Tautological property**: `expect(add(a, b)).toBe(a + b)` — redefines the function in the assertion. Use known-good values or cross-implementation comparison.
- **Filter-heavy generators**: `fc.integer().filter(x => x > 0).filter(x => x < 100)` — use `fc.integer({ min: 1, max: 99 })` instead. Filter chains cause high rejection rates and vacuous passes.
- **No-crash-only tests**: "it doesn't throw" is the floor, not the ceiling. Add an invariant even if simple.
- **Reimplementing logic in assertion**: computing expected output the same way the function does = tautology. Use an independent source of truth.
- **Ignoring shrinking**: shrunk failures are 10x more debuggable. Always capture seed + path.
- **Untested edge cases**: empty collections, null, boundaries, unicode strings — add explicit examples.

# Orchestrator Refactoring — Test Plan

Tests to run via `interactive_shell` spawning new pi sessions.

## Test 1: Extension Loads Without Error
**Goal:** Verify refactored orchestrator loads correctly.
**Method:** Start pi, immediately check for errors.
**Check:** No crash, `/orchestrate` command registered.

## Test 2: Delegate Tool Available
**Goal:** Verify orchestrator strips tools to only `delegate()`.
**Method:** Ask pi to list available tools.
**Check:** Only `delegate` tool listed.

## Test 3: Basic Scout Delegation
**Goal:** Verify scout specialist works.
**Method:** `delegate(scout, "list files in /tmp")`
**Check:** Scout returns file listing, plan panel updates.

## Test 4: Basic Coder Delegation  
**Goal:** Verify coder specialist works.
**Method:** `delegate(coder, "create /tmp/test-orchestrator.txt with content 'hello'")`
**Check:** File created, output visible.

## Test 5: Full Scout → Coder Flow
**Goal:** Verify multi-step orchestration works.
**Method:** Scout investigates, then coder implements based on findings.
**Check:** Both steps complete, plan panel shows progress.

## Test 6: Scope Enforcement
**Goal:** Verify scope-guard.ts blocks out-of-scope writes.
**Method:** Scout outputs ## Scope, coder tries to write outside scope.
**Check:** Write blocked with scope-guard error.

## Test 7: Caveman Mode Active
**Goal:** Verify full caveman prompt is working.
**Method:** Check response style — should be terse, no filler.
**Check:** Responses lack greetings/hedging.

---
name: ssot-audit
description: Audit a codebase for Single Source of Truth violations — places where schemas and their dependent documentation/tests are separated, creating maintenance risk.
---

# SSOT Audit

Find places where a schema/type/interface defines data, but documentation/examples/tests that depend on that data are defined separately — meaning a change to the schema won't automatically update the dependent code.

## What is a SSOT violation?

**Violation:** Schema in File A, dependent code in File B. Change A → must remember to update B.

**Example:**
- `ScopeManifest` interface in scope-manager.ts defines scope fields
- `generateScopeDocumentation()` in prompt-builder.ts hardcodes those same fields
- Add field to ScopeManifest → must remember to update prompt-builder.ts
- This is a SSOT violation — schema and documentation are in separate files

**Fix:** Move `generateScopeDocumentation()` INTO scope-manager.ts, next to ScopeManifest. Now schema and documentation are co-located.

## Process

### 1. Scan for schemas

Find all interfaces, types, and data shapes in the codebase:
- Search for `interface`, `type`, `export type`, `export interface`
- Note which files define data schemas

### 2. Check for dependent code

For each schema, check if there's dependent code that:
- Hardcodes field names from the schema
- Generates documentation from the schema
- Validates against the schema
- Tests against the schema

### 3. Identify violations

If schema and dependent code are in DIFFERENT files, it's a potential SSOT violation. Check:
- Is the dependent code derived from the schema (good)?
- Or is it hardcoded separately (violation)?

### 4. Report findings

For each violation:
- **Schema file:** which file defines the interface/type
- **Dependent code:** which file has the hardcoded dependency
- **Risk:** what breaks if schema changes without updating dependent code
- **Fix:** move dependent code to the same file as the schema

## Output format

```
## SSOT Audit Results

### Violations Found: N

#### 1. [Schema Name]
- **Schema:** `path/to/file.ts` — `InterfaceName`
- **Dependent:** `path/to/other.ts` — `functionName()`
- **Risk:** [what breaks]
- **Fix:** [move X to Y file]

### Already Correct: N
[List files where schema and dependencies are co-located]
```

## What is NOT a violation

- Schema in one file, logic that USES the schema in another file (that's normal dependency)
- Schema in one file, tests that test the schema in another file (tests are separate by design)
- Dynamic generation from runtime data (that's SSOT-compliant — the data IS the source)

## Common patterns to check

| Pattern | Check |
|---------|-------|
| Interface + prompt documentation | Are they in the same file? |
| Type + validation logic | Are they in the same file? |
| Schema + test fixtures | Are fixtures derived from schema or hardcoded? |
| Config type + config defaults | Are defaults derived from type or hardcoded? |
| Enum + string literals | Are string literals derived from enum or duplicated? |

# Domain Glossary

## Scope

Canonical model for a subagent delegation's allowed filesystem reach and enforcement policy. Includes structural/policy fields: filesToCreate, filesToModify, directories, maxFiles, gateMode, and boundaries. Excludes presentation formatting and per-specialist default decisions (those live in ScopePolicy).

_Avoid:_ scope gate, delegation limits, file permissions

## ScopeManager

The module that owns the Scope concept — its extraction from subagent output, in-memory cache, persistent scope I/O, typed API, scope construction helpers, and changeType-to-gateMode derivation. When normalizing a ScopeManifest to a ResolvedScope, it resolves changeType into gateMode. It does not decide per-specialist defaults; callers choose which policy to apply.

_Avoid:_ scope store, scope registry, scope service

## ScopeManifest

Input/authoring view of a Scope produced by extraction or default construction, before normalization for enforcement. May contain raw lists, unresolved patterns, or policy choices that still need expansion and validation. ScopeManager turns a ScopeManifest into a ResolvedScope.

_Avoid:_ raw scope, scope request, scope source

## ResolvedScope

Enforcement-ready view of a Scope that ScopeGuard consumes. Produced by normalizing a ScopeManifest: boundaries and policy decisions are resolved into a flat allowed set of files, directories, and limits. No parsing, no defaults, no construction.

_Avoid:_ resolved permissions, flattened scope, scope snapshot

## ScopeGuard

Thin enforcement adapter that reads the ResolvedScope from ScopeManager through a narrow read API and blocks out-of-scope tool calls. It knows nothing about scope extraction, caching, defaults, or the scope file path.

_Avoid:_ scope validator, scope enforcer, permission guard

## ScopePolicy

The per-specialist decision about what default scope to apply, such as which specialist receives a doc-friendly default.

_Avoid:_ scope rules, scope defaults, specialist config

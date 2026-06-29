# ADR 0003: Activity Feed Researcher Tool Display

## Status
Accepted

## Context
Researcher tool calls (web_search, fetch_content) displayed poorly in the activity feed substep area. web_search showed "..." instead of the query string. fetch_content showed an empty URL. Root cause: the researcher tool uses singular parameter names (query, url) but the feed builder expected plural (queries, urls), so label extraction fell through to a fallback that truncated to "...".

## Decision

### web_search substep display
- Substep label shows first query + result count: `"Web search: <first 60 chars of first query> (N results)"`
- If multiple queries, remaining queries rendered in tool_detail, separated by `\n`
- On completion, substep label shows result count: `"found N results"` (uses `results_count` from tool response)

### fetch_content substep display
- Substep label shows URL with protocol stripped: `"Fetch content: <host><path>"` (e.g. `"Fetch content: example.com/doc"`)
- URL protocol prefix (`https://`, `http://`) stripped for readability
- On failure, error rendered in tool_detail: `"Error: <error message>"`

### Multi-line tool_detail
- `setToolDetail()` accepts `\n`-separated strings
- Renderer splits on `\n` and renders each line with a spinner animation (same spinner as the parent substep)
- Spinner provides better visual feedback as it indicates the tool is still actively running
- Cleared after results are complete

### Plural fallback handling
- When feed builder checks `params.queries`, fall back to `params.query` (singular) wrapped in array
- Same for `params.urls` → `params.url`
- Empty array guard: if resolved array is empty, label shows `"<tool name>: (no input)"`
- Single-item normalization: if resolved array has one item, always use singular-style label (no count suffix)

## Consequences
- Tool labels now show meaningful content instead of "..." or empty strings
- `toolDetail` multi-line rendering is generic enough for future tool use
- Plural fallback adds a minor coupling to tool param naming conventions but resolves the mismatch without breaking existing tool definitions
- Empty array guard prevents confusing "0 results" labels
- Protocol stripping is purely cosmetic — full URL still available in tool detail if needed

# herdr-agent-state

Shares pi's agent state with the other panes managed by [herdr](https://github.com/).

## What it solves

When several agent panes run side by side, each one needs to publish whether it is working, blocked, or idle so the others can coordinate. This extension is the bridge that reports pi's state to herdr over its local socket.

## Notes

- **Managed by herdr — do not hand-edit.** This file is installed and maintained by herdr; reinstalling or updating the integration overwrites it. Add custom hooks and plugins beside this file instead.
- No-op unless herdr set the environment: it stays silent unless `HERDR_ENV=1` and a socket/pane id are present.
- Reports states `working`, `blocked`, and `idle`, with a debounce on idle and a retry grace window for transient provider errors.
- Customizable through environment variables such as `HERDR_PI_IDLE_DEBOUNCE_MS` and `HERDR_PI_RETRY_GRACE_MS`.

## Source

`herdr-agent-state.ts` — generated integration (pinned by `HERDR_INTEGRATION_ID` / `HERDR_INTEGRATION_VERSION` header).

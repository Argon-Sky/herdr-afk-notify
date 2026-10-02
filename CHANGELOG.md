# Changelog

## 1.0.0

First release.

- Notifies for every agent Herdr can see, through its `pane.agent_status_changed` event. Nothing goes into each agent's own settings.
- **Agent done** after a turn of at least `AFK_MIN_WORKING_SECONDS` (default 300), counted from the pane's first `working`. `idle` and `done` both end a turn.
- **Agent needs you** on every `blocked`, at priority 4 and tagged 👀.
- Sends only after the Mac has been idle for `AFK_AWAY_SECONDS` (default 180). A detached delivery waits for that, and drops the notification if the agent moves on, a newer event replaces it, or you focus the pane at the keyboard.
- Title is `Agent done · <tab>` or `Agent needs you · <tab>`, falling back to the pane's terminal title for an automatically numbered tab; the body names the agent and the turn length.
- Config through `.env` in the plugin config dir: `NTFY_TOPIC`, `NTFY_SERVER`, `NTFY_TOKEN`, `AFK_MIN_WORKING_SECONDS`, `AFK_AWAY_SECONDS`.
- macOS only.

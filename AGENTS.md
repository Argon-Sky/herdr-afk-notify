# herdr-afk-notify

A Herdr plugin that notifies the owner's phone through ntfy when an agent finishes a long turn or is blocked, only while the Mac is idle. Forked from jjuraszek/herdr-ntfy-notify; per-tab arming was removed.

## Layout

- `herdr-plugin.toml`: the manifest. One `pane.agent_status_changed` event hook, run through `run.sh`.
- `run.sh`: finds `node` when Herdr's `PATH` is bare (launchd), then runs the named script.
- `notify.mjs`: the hook. Tracks each pane's turn start and starts a detached `deliver.mjs` when a notification is due. It never waits and never calls `herdr`.
- `deliver.mjs`: waits until the Mac is idle, re-checks the agent through `herdr agent get`, names the tab and sends. Logs one outcome line to `deliver.log` in the state directory.
- `lib.mjs`: `.env` loading, per-pane state (`panes/<pane>.json`), the `herdr` CLI wrapper, idle time from `ioreg`, and the ntfy publish.
- `test/notify.test.mjs`: runs the hook against a fake `herdr`, a fake `ioreg` and an in-process ntfy server.

## Develop and test

```sh
npm test
herdr plugin link "$PWD"        # run the checkout live
herdr plugin log list --plugin argon-sky.afk-notify
```

`AFK_POLL_SECONDS` and `AFK_MAX_WAIT_SECONDS` exist for tests; they are not user settings. CI runs the suite on macOS with Node 18 and 24.

## Rules

- Node 18 or newer, standard library only. No dependencies, no build step.
- The hook stays fast and never fails Herdr: exit 0 on anything unexpected. Anything that waits belongs in `deliver.mjs`.
- Never send agent output. The notification carries the tab name, the agent name and the turn length only, because a public ntfy topic is readable by anyone who knows it.
- Never commit `.env`. Config lives in `herdr plugin config-dir argon-sky.afk-notify`.
- The version lives in `herdr-plugin.toml` and `package.json`; bump both together with a `CHANGELOG.md` entry.
- A user-visible change updates `README.md` and `CHANGELOG.md` in the same commit.
- Keep one opinionated default. Don't add options until someone needs them.
- No hard wrapping in code comments, docs or commit messages.

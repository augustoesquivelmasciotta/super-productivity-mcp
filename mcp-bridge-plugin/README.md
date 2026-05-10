# MCP Bridge plugin — build flow

SP loads `plugin.js`, not `plugin-logic.js`. `plugin.js` is a bundle of
`socket.io.min.js + plugin-logic.js` (concatenation, no transpile). If you
edit `plugin-logic.js` and forget to rebuild, SP will keep running the old
bundled code — silent stale-build hazard.

The pre-2026-04-25 incarnation of this plugin had a stale `plugin.js` checked
in that didn't reflect changes made to `plugin-logic.js` over months. Diagnosis
took most of a session. The build script + heartbeat below exist so this can't
happen again.

## Files

- `plugin-logic.js` — source of truth for plugin behaviour. Edit this.
- `socket.io.min.js` — vendored library. Don't edit.
- `manifest.json` — SP plugin metadata. Bump `version` on every release.
- `plugin.js` — **built artifact**. Don't edit by hand. Regenerate via build script.

## Build

```bash
npm run build:plugin   # rebuilds plugin.js
npm run package        # rebuilds plugin.js AND repackages ../mcp-bridge-plugin.zip
```

## Heartbeat (how to verify the new code is actually running)

`plugin-logic.js` emits two events on every plugin connect:

- `event:debug:startup` — `{ version, socketId }`. Logged by the server as
  `[plugin-heartbeat] startup ...`.
- `event:debug:hooksRegistered` — `{ ok: [...], err: {...} }`. Logged as
  `[plugin-heartbeat] hooks registered ...`.

After importing a new zip into SP, tail
`~/Library/Logs/super-productivity-mcp.log` and confirm the version stamp
matches `manifest.json`. If it doesn't, the build is stale.

## Verbose mode

For diagnosing why a transition wasn't detected, set
`SP_MCP_DEBUG_EVENTS=1` in `~/Library/LaunchAgents/com.augus.super-productivity-mcp.plist`,
then `launchctl unload && launchctl load`. The server will log every event
the plugin emits + per-event detail from `unschedule-mirror`. Off by default.

## Hooks

Four hooks registered (verified 2026-04-25 against SP 18.2.8):

| Hook | Channel | Purpose |
|------|---------|---------|
| `taskUpdate` | `event:taskUpdate` | Schedule/unschedule/reschedule/move/edit. Drives the mirror's transition detection. |
| `taskCreated` | `event:taskCreated` | New task creation (UI or MCP). Hydrates cache. |
| `taskDelete` | `event:taskDelete` | Task deletion (single or batch). Cleans cache. |
| `action` (filtered) | `event:taskScheduled` | Whitelist of redux actions taskUpdate misses. Currently `[Task Shared] planTasksForToday` only. |

We do **not** register `anyTaskUpdate`. It only fires for
`addTask/updateTask/deleteTask` actions and misses every UI scheduling
action (`unscheduleTask`, `scheduleTaskWithTime`, `planTaskForDay`, etc.).
That was the root cause of months of silent unschedule-mirror failures
on UI drags before 2026-04-25.

We do **not** register `action` unfiltered. SP dispatches dozens of redux
actions per minute during normal use (panel toggles, work-context switches,
selection changes); forwarding all of them to the server would explode the
log and force the listener to filter on every event. The whitelist
`FORWARDED_ACTIONS` in `plugin-logic.js` is the place to add new entries
if a future SP version introduces a scheduling action that doesn't flow
through `taskUpdate`.

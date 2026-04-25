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
- `plugin.ts` — historical, unused. Kept for reference; not part of the build.

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

We register only `taskUpdate`. We do **not** register `anyTaskUpdate` —
empirically it does NOT fire for UI scheduling actions
(`unscheduleTask`, `scheduleTaskWithTime`, `planTaskForDay`, etc.), only for
generic `addTask/updateTask/deleteTask` redux actions. `taskUpdate` covers
the scheduling family. Verified 2026-04-25 by registering all 11 SP hooks
and observing UI drag&drop. See `decisiones.md`.

Known gap: `[Task Shared] planTasksForToday` (drag-to-Today UI action) is not
covered by `taskUpdate`. Tasks are usually scheduled via `/dia` (MCP path,
which uses `updateTask` and is covered) or via drag-to-future-day
(`planTaskForDay`, also covered). The gap is "drag to Today + drag back" in
the same session for a task whose scheduled state was never recorded by the
listener cache. If this bites in practice, add `action` hook filtered to
`planTasksForToday`.

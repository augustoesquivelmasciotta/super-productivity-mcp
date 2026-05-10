# Install Super Productivity and the MCP Bridge plugin

## Super Productivity

1. Install [Super Productivity](https://super-productivity.com/) (desktop **v14+** required for the plugin API used here).
2. For **headless Linux** (no monitor), run the app on a virtual display (e.g. Xvfb `:99`) and set `DISPLAY=:99`. See [SYSTEMD.md](SYSTEMD.md) for example units.

## MCP Bridge plugin

The plugin lives in `mcp-bridge-plugin/` in this repository. To ship it as a single file for **Settings → Plugins → Install from file**, zip that folder so `manifest.json` sits at the root of the archive.

**Headless server tip:** install and **enable** the plugin on a machine with a real display first (using the ZIP or a manual folder copy), then rely on Super Productivity **sync** or a **copied profile** so a VPS or Xvfb-only host gets the same `plugins/mcp-bridge` tree and enabled state without fighting a plugin UI over SSH alone.

1. Copy the **contents** of `mcp-bridge-plugin/` into the Super Productivity plugins directory, for example:
   - `~/.config/superProductivity/plugins/mcp-bridge/`
2. On some systems the config folder may use different casing (e.g. `SuperProductivity`). Use the path your installation actually writes to.
3. In Super Productivity: **Settings → Plugins** — enable **MCP Bridge**.
4. Edit the Socket.IO URL in `plugin.js` / `plugin-logic.js` if needed:

   ```js
   var socket = io("http://127.0.0.1:3996", { ... });
   ```

   Use the same **host** and **port** the MCP server listens on. The server code defaults to `PORT=3000` if no environment variable is set, but the plugin file defaults to `http://127.0.0.1:3996` — set `PORT=3996` when starting the server (or edit the plugin URL) so both sides agree. See [MCP_SERVER.md](MCP_SERVER.md).

   On Linux prefer **`127.0.0.1`** over `localhost` when the server is bound to IPv4 only (e.g. `MCP_HOST=127.0.0.1` or Docker publish `127.0.0.1:<hostPort>:<containerPort>`), because `localhost` may resolve to `::1` and the socket will not connect.

   If the server uses **`MCP_HOST=0.0.0.0`** (Docker or LAN), the plugin on the **same machine** can still use `http://127.0.0.1:<PORT>`.

5. Restart Super Productivity after changing the plugin or server port.

## Sync the plugin after a `git pull`

The app loads files from your profile (e.g. `~/.config/superProductivity/plugins/mcp-bridge/`), not from this repo. After updating the repository:

1. **Copy or rsync** the runtime files from `mcp-bridge-plugin/` into that folder (overwrite `plugin.js`, `plugin-logic.js`, `socket.io.min.js`, `manifest.json` as needed). Example:

   ```bash
   rsync -a \
     ./mcp-bridge-plugin/manifest.json \
     ./mcp-bridge-plugin/plugin.js \
     ./mcp-bridge-plugin/plugin-logic.js \
     ./mcp-bridge-plugin/socket.io.min.js \
     ~/.config/superProductivity/plugins/mcp-bridge/
   ```

   Adjust the destination path if your profile directory differs.

2. Or build a **ZIP** from the repo and reinstall via **Settings → Plugins**:

   ```bash
   npm run plugin:zip
   ```

   That writes `mcp-bridge-plugin.zip` at the repository root (ignored by Git). Install it in Super Productivity, or unzip over `plugins/mcp-bridge/` yourself.

3. If **`manifest.json` `version`** changed, the app may show an update depending on Super Productivity’s plugin UI.

## Verify

- Start the MCP server first, then Super Productivity (or restart the app after the server is up).
- In the MCP server logs you should see a line like: `Super Productivity plugin connected:` followed by a socket id.

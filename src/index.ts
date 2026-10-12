#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { App } from "./app.js";
import { loadConfig } from "./config.js";
import { openInBrowser } from "./lichess/auth.js";
import { createServer, VERSION } from "./server.js";
import { checkForUpdate, describeResult, installRoot, lastUpdateResult, updateSettings } from "./update.js";

const args = process.argv.slice(2);
const update = updateSettings(process.env);
const app = () => new App(loadConfig(), { openBrowser: openInBrowser });

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`chess-mcp ${VERSION}: play chess against the Lichess AI from any MCP client (stdio).

Flags:
  --login             Connect your Lichess account in the browser, then exit
  --status            Show which Lichess account is connected, then exit
  --logout            Sign out: revoke the token and delete it from this computer
  --update            Update to the latest version now, then exit
  --version, --help

Environment (all optional):
  LICHESS_TOKEN       A personal API token (scopes challenge:write, board:play) instead of signing in
  CHESS_DEFAULT_LEVEL Lichess AI strength when none is asked for, 1-8 (default 3)
  CHESS_BOARD_STYLE   "unicode" (default, chess symbols) or "letters" (KQRBNP / kqrbnp)
  CHESS_OPEN_BROWSER=0  Don't open the sign-in page automatically; just show the link
  CHESS_MCP_HOME      Where game notes live (default ~/.chess-mcp)
  CHESS_AUTO_UPDATE=0 Turn off automatic updates from GitHub (on by default)
  CHESS_UPDATE_CHANNEL  "release" (default: the latest GitHub release) or "main"`);
} else if (args.includes("--update")) {
  const result = await checkForUpdate({ root: installRoot(), channel: update.channel, force: true, log: (m) => console.log(m) });
  console.log(describeResult(result, { ...update, enabled: true }));
  process.exit(result.status === "failed" ? 1 : 0);
} else if (args.includes("--login")) {
  const a = app();
  const pending = await a.login.start();
  console.log(`Opening Lichess in your browser. If it doesn't open, visit:\n\n  ${pending.url}\n\nWaiting for you to approve (10 minutes)…`);
  try {
    const account = await pending.done;
    console.log(`Connected as ${account.username}. The token is kept in ${a.tokens.where}.`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
} else if (args.includes("--logout")) {
  console.log(await app().logout());
} else if (args.includes("--status")) {
  try {
    console.log(await app().status());
    console.log(`Version ${VERSION}. ${describeResult(await lastUpdateResult(installRoot()), update)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
} else {
  const last = update.enabled ? await lastUpdateResult(installRoot()).catch(() => undefined) : undefined;
  // Tell the agent about an update that just happened, or one that failed and needs attention.
  const notices = last && (last.status === "failed" || (last.status === "updated" && Date.now() - Date.parse(last.at) < 24 * 3600_000)) ? [describeResult(last, update)] : [];
  const server = createServer(app(), { notices });
  await server.connect(new StdioServerTransport());
  if (update.enabled) {
    // Update in the background after startup; the new version is used from the next start.
    setTimeout(() => {
      checkForUpdate({ root: installRoot(), channel: update.channel, log: (m) => console.error(m) }).catch(() => {});
    }, 2_000).unref();
  }
}

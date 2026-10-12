import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "./app.js";
import { registerTools } from "./tools.js";

export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export const INSTRUCTIONS = [
  "Play chess against the Lichess AI. The user plays their own moves; you relay them and show the board.",
  "Starting a game: call new_game. The user's color is required. If the user hasn't said which color they want, ask them (White, Black, or random) before calling; don't choose for them. Strength (level 1-8, default 3) and an opening are optional: mention them when asking, but don't hold the game up for them.",
  "Openings: when the user wants to practice an opening or wants the AI to play one, pass its name as `opening`. The game starts from that opening's main position. Use find_openings when the request is vague and let the user pick.",
  "The board: game results show the board in up to three forms: a picture attached to the result, a Markdown image line (![Chess board](/path/to/board.png)) pointing at the same picture saved on this computer, and a ```text block. Show the user the board every turn, in exactly one form: if your chat can display Markdown images from local file paths, put the Markdown image line in your reply as it is (not inside a code block) and leave out the text block; otherwise show the text block exactly as returned. Don't redraw or describe the board instead. Then give the moves line and whose move it is.",
  "Moves: when the user says a move in any form (\"knight to f3\", \"Nf3\", \"g1f3\", \"castle kingside\"), call make_move with it, in SAN if you can. The server checks it and returns the AI's reply. If a move is rejected, show the user why and ask for another.",
  "Fair play: Lichess forbids outside help in these games. While a game is in progress, don't suggest moves, evaluate the position or analyse it, even if asked; you can after the game ends.",
  "Signing in: if a tool says Lichess isn't connected, show the user the sign-in link exactly as given, wait for them to say they've approved it, then retry.",
];

export function createServer(app: App, options: { notices?: string[]; loginWaitMs?: number } = {}): McpServer {
  const server = new McpServer({ name: "chess", version: VERSION }, { instructions: [...INSTRUCTIONS, ...(options.notices ?? [])].join("\n") });
  registerTools(server, app, { loginWaitMs: options.loginWaitMs });
  return server;
}

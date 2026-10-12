import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Chess } from "chess.js";
import { z } from "zod";
import type { App } from "./app.js";
import { findOpenings } from "./chess/openings.js";
import { LichessError, NotConnected, TokenRejected } from "./lichess/client.js";
import { UserError } from "./play.js";

const gameId = z
  .string()
  .optional()
  .describe("The game ID or Lichess URL. Leave it out for the current game.");

/** How long a tool waits for a sign-in that's in progress before showing the link again. */
const LOGIN_WAIT_MS = 45_000;

export function registerTools(server: McpServer, app: App, options: { loginWaitMs?: number } = {}): void {
  const loginWaitMs = options.loginWaitMs ?? LOGIN_WAIT_MS;
  const play = (fn: () => Promise<string>) => run(app, fn, loginWaitMs);

  server.registerTool(
    "new_game",
    {
      title: "Start a game against the Lichess AI",
      description:
        "Starts a new game against the Lichess AI and returns the board. `color` is the user's color and is required: if the user hasn't said which color they want, ask them (white, black or random) before calling. Optionally set the AI's strength (`level` 1-8) and an `opening` to start from (a name like \"Sicilian Najdorf\", \"London System\" or an ECO code like B90); the game then starts from that opening's main position.",
      inputSchema: {
        color: z.enum(["white", "black", "random"]).describe("The color the user plays."),
        level: z.number().int().min(1).max(8).optional().describe("Lichess AI strength, 1 (beginner) to 8 (strongest). Default 3."),
        opening: z.string().optional().describe("An opening name or ECO code to start from. Use find_openings to explore."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => play(() => app.play.newGame(args)),
  );

  server.registerTool(
    "make_move",
    {
      title: "Play the user's move",
      description:
        "Plays the user's move in their game and waits for the Lichess AI's reply, then returns the board. Pass the move the user said, preferably in SAN (Nf3, exd5, O-O, e8=Q); UCI (g1f3) also works. An illegal move is rejected with the list of legal moves.",
      inputSchema: {
        move: z.string().min(1).describe("The user's move, e.g. Nf3, exd5, O-O, e7e8q."),
        game_id: gameId,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ move, game_id }) => play(() => app.play.move(move, game_id)),
  );

  server.registerTool(
    "show_board",
    {
      title: "Show the board",
      description: "Shows the current board, the moves so far and whose turn it is.",
      inputSchema: { game_id: gameId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ game_id }) => play(() => app.play.show(game_id)),
  );

  server.registerTool(
    "list_games",
    {
      title: "List games in progress",
      description: "Lists the user's games against the Lichess AI that are still in progress.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => play(() => app.play.listGames()),
  );

  server.registerTool(
    "find_openings",
    {
      title: "Find openings",
      description:
        "Searches the Lichess list of named openings by name or ECO code, e.g. \"najdorf\", \"queens gambit declined\", \"B90\". Use it when the user's opening request is vague, then pass the chosen name to new_game.",
      inputSchema: {
        query: z.string().min(1).describe("Opening name words or an ECO code."),
        limit: z.number().int().min(1).max(30).optional().describe("How many to return (default 8)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const found = findOpenings(query, limit ?? 8);
      if (!found.length) return text(`No openings match "${query}". Try fewer or different words.`, true);
      const lines = found.map((o) => {
        const toMove = new Chess(`${o.epd} 0 1`).turn() === "w" ? "White" : "Black";
        return `- ${o.name} (${o.eco}): ${o.pgn}. ${toMove} to move.`;
      });
      return text(`Openings matching "${query}":\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "takeback",
    {
      title: "Take back a move",
      description: "Asks the Lichess AI to take back the last move (normally the user's last move and the AI's reply). Only when the user asks for it.",
      inputSchema: { game_id: gameId },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ game_id }) => play(() => app.play.takeback(game_id)),
  );

  server.registerTool(
    "resign",
    {
      title: "Resign the game",
      description: "Resigns the user's game (or aborts it if it has barely started). Only when the user clearly asks to resign or quit.",
      inputSchema: { game_id: gameId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ game_id }) => play(() => app.play.resign(game_id)),
  );

  server.registerTool(
    "lichess_login",
    {
      title: "Sign in to Lichess",
      description:
        "Connects the user's Lichess account (needed to play). Opens the Lichess sign-in page in the user's browser and returns the link; show the link to the user. Calling it again while the user is approving waits for them to finish.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () => run(app, () => app.status(), loginWaitMs, { startLogin: true }),
  );

  server.registerTool(
    "lichess_status",
    {
      title: "Lichess connection status",
      description: "Says whether a Lichess account is connected, and which one.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(app, () => app.status(), 0, { statusOnly: true }),
  );

  server.registerTool(
    "lichess_logout",
    {
      title: "Sign out of Lichess",
      description: "Signs out of Lichess: revokes the token and deletes it from this computer. Only when the user asks.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async () => text(await app.logout()),
  );
}

async function run(app: App, fn: () => Promise<string>, loginWaitMs: number, opts: { startLogin?: boolean; statusOnly?: boolean } = {}): Promise<CallToolResult> {
  try {
    if (!opts.statusOnly && !(await app.currentToken())) {
      const pending = app.login.current ?? (opts.startLogin ? await app.login.start() : undefined);
      if (pending) {
        // The user may be approving right now: give them a moment before showing the link again.
        const signedIn = await Promise.race([pending.done.then(() => true, () => false), sleep(loginWaitMs).then(() => false)]);
        if (!signedIn) return await needLogin(app, "Lichess isn't connected yet.");
      }
    }
    return text(await fn());
  } catch (error) {
    if (error instanceof NotConnected) return needLogin(app, "Lichess isn't connected yet.");
    if (error instanceof TokenRejected) {
      if (app.config.envToken) {
        return text(
          `${error.message} The token comes from the LICHESS_TOKEN environment variable: replace it with a token that has the challenge:write and board:play permissions, or remove the variable to sign in through the browser.`,
          true,
        );
      }
      await app.dropRejectedToken();
      return needLogin(app, `${error.message} It may have been revoked or have expired, so the user needs to sign in again.`);
    }
    if (error instanceof UserError || error instanceof LichessError) return text(error.message, true);
    return text(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function needLogin(app: App, reason: string): Promise<CallToolResult> {
  let pending;
  try {
    pending = app.login.current ?? (await app.login.start());
  } catch (error) {
    return text(`${reason} Couldn't start the Lichess sign-in: ${error instanceof Error ? error.message : error}`, true);
  }
  return text(
    [
      reason,
      "Show the user this link to connect their Lichess account (a free account works; it may also have opened in their browser):",
      "",
      pending.url,
      "",
      "They sign in to Lichess and click Authorize. Wait for them to say they're done, then call the tool again. The link works for 10 minutes.",
    ].join("\n"),
    true,
  );
}

function text(message: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

import { homedir } from "node:os";
import { join } from "node:path";
import type { BoardStyle } from "./chess/board.js";

export interface Config {
  /** https://lichess.org, or a fake server in tests. */
  lichessUrl: string;
  /** A personal API token from the environment. Overrides the one saved by signing in. */
  envToken?: string;
  /** Where the saved token (outside macOS), the account name and game notes live. */
  home: string;
  boardStyle: BoardStyle;
  defaultLevel: number;
  /** Open the sign-in page in the browser (off in tests and headless setups). */
  openBrowser: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const level = Number(env.CHESS_DEFAULT_LEVEL);
  return {
    lichessUrl: (env.LICHESS_URL?.trim() || "https://lichess.org").replace(/\/+$/, ""),
    envToken: env.LICHESS_TOKEN?.trim() || undefined,
    home: env.CHESS_MCP_HOME?.trim() || join(homedir(), ".chess-mcp"),
    boardStyle: env.CHESS_BOARD_STYLE?.trim().toLowerCase() === "letters" ? "letters" : "unicode",
    defaultLevel: Number.isInteger(level) && level >= 1 && level <= 8 ? level : 3,
    openBrowser: !["0", "false", "no", "off"].includes(env.CHESS_OPEN_BROWSER?.trim().toLowerCase() ?? ""),
  };
}

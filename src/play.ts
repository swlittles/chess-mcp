// Playing against the Lichess AI through the Board API: start a game, make moves, and wait for the
// AI's reply on the game's event stream.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chess, type Move } from "chess.js";
import { renderBoard, type BoardStyle } from "./chess/board.js";
import { boardPng } from "./chess/image.js";
import { IllegalMove, numberedMoves, parseMove, replay, START_FEN, turnColor, uciOf, type Color, type Position } from "./chess/game.js";
import { epdOf, findOpenings, openingAt, type Opening } from "./chess/openings.js";
import { LichessError, Unavailable, type LichessClient } from "./lichess/client.js";
import type { GameNote, Store } from "./store.js";

export interface GameState {
  type?: "gameState";
  moves: string;
  status: string;
  winner?: Color;
  wtakeback?: boolean;
  btakeback?: boolean;
}

interface Player {
  aiLevel?: number;
  id?: string;
  name?: string;
}

export interface GameFull {
  type: "gameFull";
  id: string;
  initialFen?: string;
  white: Player;
  black: Player;
  state: GameState;
}

/** What a game action returns: the text for the agent and, when enabled, the board as a PNG. */
export interface Report {
  text: string;
  image?: Buffer;
}

/** A mistake the user can fix (bad move, no game): reported to the agent as a tool error. */
export class UserError extends Error {}

const IN_PROGRESS = new Set(["created", "started"]);

export interface PlayOptions {
  client: LichessClient;
  store: Store;
  boardStyle: BoardStyle;
  /** Where board pictures are saved. Without it, results only have the text board. */
  boardImageDir?: string;
  defaultLevel: number;
  /** How long to wait for the AI to reply before reporting that it's still thinking. */
  replyTimeoutMs?: number;
}

export class Play {
  private readonly replyTimeoutMs: number;

  constructor(private readonly o: PlayOptions) {
    this.replyTimeoutMs = o.replyTimeoutMs ?? 30_000;
  }

  async newGame(args: { color: Color | "random"; level?: number; opening?: string }): Promise<Report> {
    const level = args.level ?? this.o.defaultLevel;
    let opening: Opening | undefined;
    let fen: string | undefined;
    let alsoMatched: string[] = [];
    if (args.opening?.trim()) {
      const found = findOpenings(args.opening, 5);
      opening = found[0];
      if (!opening) throw new UserError(`No opening matches "${args.opening}". Use find_openings to search by name or ECO code.`);
      // Different openings that also matched (not just deeper lines of the chosen one).
      // An ECO code covers many openings on purpose, so only names get this note.
      if (!/^[A-E]\d\d$/i.test(args.opening.trim())) {
        alsoMatched = found.slice(1).filter((o) => !o.name.startsWith(opening!.name)).slice(0, 3).map((o) => o.name);
      }
      const chess = new Chess();
      for (const uci of opening.uci) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      fen = chess.fen();
    }

    const known = new Set(Object.keys(this.o.store.read().games));
    let id: string;
    try {
      const created = await this.o.client.request<{ id: string }>("POST", "/api/challenge/ai", {
        form: { level, color: args.color, fen },
        retry: false, // not safe to repeat: it would start a second game
      });
      id = created.id;
    } catch (error) {
      // The game may have been created even though the answer was lost. Look before giving up.
      if (!(error instanceof Unavailable)) throw error;
      const adopted = (await this.aiGames().catch(() => [])).find((g) => !known.has(g.gameId) && g.opponent?.ai === level);
      if (!adopted) throw error;
      id = adopted.gameId;
    }

    const stream = await GameStream.open(this.o.client, id);
    try {
      const color: Color = stream.full.white.aiLevel ? "black" : "white";
      const note: GameNote = {
        id,
        color,
        level,
        createdAt: new Date().toISOString(),
        ...(opening ? { opening: { eco: opening.eco, name: opening.name, pgn: opening.pgn } } : {}),
      };
      this.o.store.update((d) => {
        d.games[id] = note;
        d.current = id;
      });
      // If the AI moves first (you're Black, or the opening leaves it to move), wait for its move.
      const replied = await stream.waitFor((s) => !inProgress(s) || turnColor(this.position(stream).chess) === color, this.replyTimeoutMs);
      const intro = [
        `New game against the Lichess AI (level ${level}). You're playing ${cap(color)}${args.color === "random" ? " (picked at random)" : ""}.`,
        opening ? `Starting from ${opening.name} (${opening.eco}): ${opening.pgn}` : undefined,
        alsoMatched.length ? `"${args.opening}" also matches ${alsoMatched.join(", ")}. If the user meant one of those, resign this game and start another.` : undefined,
      ];
      return this.report(stream, note, { intro, since: 0, stillThinking: !replied });
    } finally {
      stream.close();
    }
  }

  async move(input: string, gameId?: string): Promise<Report> {
    const id = await this.resolveGame(gameId);
    const stream = await GameStream.open(this.o.client, id);
    try {
      const note = this.noteFor(stream.full);
      if (!inProgress(stream.state)) return this.report(stream, note, { intro: ["This game is already over."] });

      // Normally it's the user's turn; if the AI is still thinking, give it a moment.
      if (turnColor(this.position(stream).chess) !== note.color) {
        const ready = await stream.waitFor((s) => !inProgress(s) || turnColor(this.position(stream).chess) === note.color, this.replyTimeoutMs);
        if (!ready) return this.report(stream, note, { intro: ["It isn't your turn yet: the Lichess AI is still thinking. Your move wasn't played."], stillThinking: true });
        if (!inProgress(stream.state)) return this.report(stream, note, {});
      }

      const position = this.position(stream);
      let move: Move;
      try {
        move = parseMove(position.chess, input);
      } catch (error) {
        if (error instanceof IllegalMove) throw new UserError(error.message);
        throw error;
      }
      const count = position.moves.length;
      await this.sendMove(stream, id, uciOf(move), count);
      const replied = await stream.waitFor((s) => !inProgress(s) || plies(s) >= count + 2, this.replyTimeoutMs);
      return this.report(stream, note, { since: count, stillThinking: !replied });
    } finally {
      stream.close();
    }
  }

  async show(gameId?: string): Promise<Report> {
    const id = await this.resolveGame(gameId);
    const stream = await GameStream.open(this.o.client, id);
    try {
      return this.report(stream, this.noteFor(stream.full), {});
    } finally {
      stream.close();
    }
  }

  async resign(gameId?: string): Promise<Report> {
    const id = await this.resolveGame(gameId);
    const stream = await GameStream.open(this.o.client, id);
    try {
      const note = this.noteFor(stream.full);
      if (!inProgress(stream.state)) return this.report(stream, note, { intro: ["This game is already over."] });
      // A game that hasn't really started can only be aborted; Lichess refuses a resignation there.
      const endpoint = plies(stream.state) < 2 ? "abort" : "resign";
      await this.o.client.request("POST", `/api/board/game/${id}/${endpoint}`, { retry: true });
      await stream.waitFor((s) => !inProgress(s), 10_000);
      return this.report(stream, note, {});
    } finally {
      stream.close();
    }
  }

  async takeback(gameId?: string): Promise<Report> {
    const id = await this.resolveGame(gameId);
    const stream = await GameStream.open(this.o.client, id);
    try {
      const note = this.noteFor(stream.full);
      if (!inProgress(stream.state)) return this.report(stream, note, { intro: ["This game is already over."] });
      const before = plies(stream.state);
      if (before === 0) throw new UserError("There's no move to take back yet.");
      await this.o.client.request("POST", `/api/board/game/${id}/takeback/yes`, { retry: true });
      const accepted = await stream.waitFor((s) => plies(s) < before, 10_000);
      return this.report(stream, note, {
        intro: [accepted ? "Takeback accepted." : "The Lichess AI didn't accept the takeback, so the position hasn't changed."],
      });
    } finally {
      stream.close();
    }
  }

  async listGames(): Promise<string> {
    const games = await this.aiGames();
    if (!games.length) return "No games against the Lichess AI in progress. Start one with new_game.";
    const notes = this.o.store.read();
    const lines = games.map((g) => {
      const note = notes.games[g.gameId];
      const flag = g.gameId === notes.current ? " (current)" : "";
      return `- ${g.gameId}${flag}: you're ${cap(g.color)} vs AI level ${g.opponent?.ai ?? "?"}, ${g.isMyTurn ? "your move" : "AI to move"}${
        note?.opening ? `, from ${note.opening.name}` : ""
      }. ${this.o.client.baseUrl}/${g.gameId}${g.color === "black" ? "/black" : ""}`;
    });
    return `Games against the Lichess AI in progress:\n${lines.join("\n")}`;
  }

  // -------------------------------------------------------------------------------------------

  /** Sends a move. If the answer is lost, checks whether it arrived before sending it again. */
  private async sendMove(stream: GameStream, id: string, uci: string, count: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.o.client.request("POST", `/api/board/game/${id}/move/${uci}`, { retry: false });
        return;
      } catch (error) {
        if (error instanceof LichessError && error.status === 400) throw new UserError(`Lichess refused the move: ${error.message}`);
        if (!(error instanceof Unavailable) || attempt >= 1) throw error;
        if (await stream.waitFor((s) => plies(s) > count, 3_000)) return;
      }
    }
  }

  private position(stream: GameStream): Position {
    return replay(stream.full.initialFen, stream.state.moves);
  }

  private noteFor(full: GameFull): GameNote {
    const saved = this.o.store.read().games[full.id];
    if (saved) return saved;
    // A game started elsewhere (or before the notes were kept): work it out from the players.
    const ai = full.white.aiLevel ? full.white : full.black;
    return { id: full.id, color: full.white.aiLevel ? "black" : "white", level: ai.aiLevel ?? 0, createdAt: new Date().toISOString() };
  }

  private async resolveGame(gameId?: string): Promise<string> {
    if (gameId?.trim()) {
      // Accept a full URL or an 8-character game ID (or the 12-character one with the player suffix).
      const id = gameId.trim().replace(/^.*\//, "").slice(0, 8);
      return id;
    }
    const current = this.o.store.read().current;
    const games = await this.aiGames();
    if (current && games.some((g) => g.gameId === current)) return current;
    if (games.length === 1) {
      this.o.store.update((d) => (d.current = games[0]!.gameId));
      return games[0]!.gameId;
    }
    if (!games.length) throw new UserError("There's no game in progress. Start one with new_game.");
    throw new UserError(`There are ${games.length} games in progress; say which one with game_id. Use list_games to see them.`);
  }

  private async aiGames(): Promise<PlayingGame[]> {
    const { nowPlaying = [] } = await this.o.client.request<{ nowPlaying?: PlayingGame[] }>("GET", "/api/account/playing", { query: { nb: 50 } });
    return nowPlaying.filter((g) => g.opponent?.ai);
  }

  /** The text shown after every action. `since`: describe the moves from this ply on. */
  private report(stream: GameStream, note: GameNote, extra: { intro?: (string | undefined)[]; since?: number; stillThinking?: boolean }): Report {
    const { full, state } = stream;
    const position = this.position(stream);
    const { chess, moves } = position;
    const last = moves.at(-1);
    const lines: string[] = [...(extra.intro ?? []).filter((l): l is string => Boolean(l))];

    if (extra.since !== undefined) {
      const recent = moves.slice(extra.since).map((m) => (m.color === note.color[0] ? `You played ${m.san}.` : `The Lichess AI played ${m.san}.`));
      if (recent.length) lines.push(recent.join(" "));
    }

    let image: Buffer | undefined;
    lines.push("");
    if (this.o.boardImageDir) {
      image = boardPng(chess, { perspective: note.color, lastMove: last });
      const path = saveBoard(this.o.boardImageDir, `${full.id}-${moves.length}`, image);
      lines.push(`![Chess board](${/\s/.test(path) ? `<${path}>` : path})`, "");
    }
    lines.push("```text", renderBoard(chess, { perspective: note.color, lastMove: last, style: this.o.boardStyle }), "```", "");

    if (position.startFen !== START_FEN) {
      lines.push(note.opening ? `Started from: ${note.opening.name} (${note.opening.eco}): ${note.opening.pgn}` : `Started from the position ${position.startFen}`);
    }
    lines.push(`Moves: ${moves.length ? numberedMoves(position.startFen, moves) : "none yet"}`);
    const opening = currentOpening(position);
    if (opening) lines.push(`Opening: ${opening.name} (${opening.eco})`);

    if (!inProgress(state)) {
      lines.push(resultLine(state, note.color));
    } else if (extra.stillThinking && turnColor(chess) !== note.color) {
      lines.push("The Lichess AI is still thinking. Call show_board in a moment to see its move.");
    } else {
      const yours = turnColor(chess) === note.color;
      lines.push(`${yours ? `Your move (${cap(note.color)})` : "The Lichess AI is to move"}.${chess.isCheck() ? " Check!" : ""}`);
      if (state.wtakeback || state.btakeback) lines.push("A takeback is being proposed.");
    }
    lines.push(`Lichess AI level ${note.level || "?"} · Game: ${this.o.client.baseUrl}/${full.id}${note.color === "black" ? "/black" : ""}`);
    return { text: lines.join("\n"), image };
  }
}

interface PlayingGame {
  gameId: string;
  color: Color;
  isMyTurn: boolean;
  opponent?: { ai?: number; username?: string };
}

/** The event stream of one game: the full game first, then a state update after every move. */
export class GameStream {
  full!: GameFull;
  state!: GameState;
  private lines!: AsyncGenerator<Record<string, unknown>>;
  private pending?: Promise<IteratorResult<Record<string, unknown>>>;
  private controller = new AbortController();
  private ended = false;

  private constructor(
    private readonly client: LichessClient,
    private readonly id: string,
  ) {}

  static async open(client: LichessClient, id: string): Promise<GameStream> {
    const stream = new GameStream(client, id);
    await stream.connect();
    return stream;
  }

  /** Reads updates until `done` holds, the game ends, or the time is up. Reconnects if the stream drops. */
  async waitFor(done: (state: GameState) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let reconnects = 0;
    while (!done(this.state)) {
      if (this.ended || !inProgress(this.state)) return done(this.state);
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const next = (this.pending ??= this.lines.next());
      let result: IteratorResult<Record<string, unknown>> | "timeout";
      try {
        result = await Promise.race([next, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), left)))]);
      } catch (error) {
        this.pending = undefined;
        if (!(error instanceof Unavailable) || ++reconnects > 2) throw error;
        await this.connect();
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (result === "timeout") return false;
      this.pending = undefined;
      if (result.done) {
        this.ended = true;
        break;
      }
      if (result.value.type === "gameState") this.state = result.value as unknown as GameState;
      else if (result.value.type === "gameFull") this.setFull(result.value as unknown as GameFull);
    }
    return done(this.state);
  }

  close(): void {
    this.controller.abort();
  }

  private async connect(): Promise<void> {
    this.controller.abort();
    this.controller = new AbortController();
    this.pending = undefined;
    const controller = this.controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      this.lines = await this.client.openStream(`/api/board/game/stream/${this.id}`, controller.signal);
      const first = await this.lines.next();
      if (first.done || first.value.type !== "gameFull") {
        throw new Unavailable(controller.signal.aborted ? "Lichess didn't send the game within 20 seconds." : "Lichess closed the game stream before sending the game.");
      }
      this.setFull(first.value as unknown as GameFull);
    } catch (error) {
      if (error instanceof LichessError && error.status === 404) throw new UserError(`Lichess has no game ${this.id}.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private setFull(full: GameFull): void {
    this.full = full;
    this.state = full.state;
  }
}

const KEEP_BOARDS_MS = 14 * 24 * 3600_000;

/**
 * Saves a board picture and returns its path. Every position gets its own file, so a picture
 * already shown in the chat never changes. Pictures older than two weeks are deleted.
 */
function saveBoard(dir: string, name: string, png: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}-${createHash("sha256").update(png).digest("hex").slice(0, 8)}.png`);
  writeFileSync(path, png, { mode: 0o600 });
  const cutoff = Date.now() - KEEP_BOARDS_MS;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".png")) continue;
    try {
      if (statSync(join(dir, file)).mtimeMs < cutoff) rmSync(join(dir, file), { force: true });
    } catch {
      // already gone
    }
  }
  return path;
}

function inProgress(state: GameState): boolean {
  return IN_PROGRESS.has(state.status);
}

function plies(state: GameState): number {
  return state.moves.split(" ").filter(Boolean).length;
}

/** The deepest named opening the game passed through. */
function currentOpening(position: Position): Opening | undefined {
  let found = openingAt(epdOf(position.startFen));
  for (const move of position.moves) found = openingAt(epdOf(move.after)) ?? found;
  return found;
}

function resultLine(state: GameState, you: Color): string {
  const winner = state.winner ? (state.winner === you ? "You win" : "The Lichess AI wins") : undefined;
  switch (state.status) {
    case "mate":
      return `Checkmate. ${winner}!`;
    case "resign":
      return state.winner === you ? "The Lichess AI resigned. You win!" : "You resigned. The Lichess AI wins.";
    case "stalemate":
      return "Stalemate. The game is a draw.";
    case "draw":
    case "insufficientMaterialClaim":
      return "The game is a draw.";
    case "outoftime":
    case "timeout":
      return `${winner ?? "The game ended"} on time.`;
    case "aborted":
      return "The game was aborted.";
    case "noStart":
      return "The game was aborted because the first move wasn't played in time.";
    default:
      return `Game over (${state.status})${winner ? `. ${winner}.` : "."}`;
  }
}

function cap(color: string): string {
  return color[0]!.toUpperCase() + color.slice(1);
}

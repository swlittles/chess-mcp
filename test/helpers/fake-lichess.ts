// A small Lichess over real HTTP: the AI challenge, Board API game streams and moves, the
// account endpoints and OAuth with PKCE. The AI plays instantly and predictably. Failures can be
// injected per path to test retries, rate limits and lost answers.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Chess, type Move } from "chess.js";

type Failure = number | "drop" | "apply-then-drop";

interface FakeGame {
  id: string;
  aiLevel: number;
  user: "white" | "black";
  initialFen: string;
  chess: Chess;
  /** Moves as Lichess writes them: castling is king-takes-rook. */
  moves: string[];
  status: string;
  winner?: "white" | "black";
  streams: Set<ServerResponse>;
}

export class FakeLichess {
  url = "";
  readonly requests: { method: string; path: string }[] = [];
  readonly tokens = new Set<string>(["lip_valid"]);
  readonly games = new Map<string, FakeGame>();
  /** Delay before the AI replies. */
  aiDelayMs = 10;
  /** Whether the AI accepts takebacks. */
  acceptTakebacks = true;
  maxConcurrent = 0;
  private active = 0;
  private failures: { path: RegExp; kind: Failure; times: number }[] = [];
  private codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  private server?: Server;

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const g of this.games.values()) for (const s of g.streams) s.end();
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }

  fail(path: RegExp, kind: Failure, times = 1): void {
    this.failures.push({ path, kind, times });
  }

  countRequests(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length;
  }

  /** Plays the user's part of the OAuth flow: approve on Lichess, follow the redirect. */
  async approve(authorizeUrl: string): Promise<Response> {
    const params = new URL(authorizeUrl).searchParams;
    const code = randomBytes(8).toString("hex");
    this.codes.set(code, { challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")!, clientId: params.get("client_id")! });
    return fetch(`${params.get("redirect_uri")}?code=${code}&state=${params.get("state")}`);
  }

  async deny(authorizeUrl: string): Promise<Response> {
    const params = new URL(authorizeUrl).searchParams;
    return fetch(`${params.get("redirect_uri")}?error=access_denied&error_description=user+cancelled&state=${params.get("state")}`);
  }

  // -------------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.url);
    const path = url.pathname;
    this.requests.push({ method: req.method!, path });
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    res.on("close", () => this.active--);
    const body = await readBody(req);

    const failure = this.failures.find((f) => f.path.test(path) && f.times > 0);
    if (failure) {
      failure.times--;
      if (failure.kind === "drop") return void req.socket.destroy();
      if (failure.kind !== "apply-then-drop") return json(res, failure.kind, { error: `injected ${failure.kind}` });
    }
    const respond = failure?.kind === "apply-then-drop" ? () => void req.socket.destroy() : undefined;

    if (path === "/api/token" && req.method === "POST") return this.exchange(res, new URLSearchParams(body));
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token || !this.tokens.has(token)) return json(res, 401, { error: "No such token" });
    if (path === "/api/token" && req.method === "DELETE") {
      this.tokens.delete(token);
      return void res.writeHead(204).end();
    }
    if (path === "/api/account") return json(res, 200, { id: "tester", username: "Tester" });
    if (path === "/api/account/playing") return json(res, 200, { nowPlaying: [...this.games.values()].filter((g) => live(g)).map(playing) });
    if (path === "/api/challenge/ai" && req.method === "POST") {
      const result = this.challenge(new URLSearchParams(body));
      if (respond) return respond();
      return json(res, result.status, result.body);
    }

    const m = path.match(/^\/api\/board\/game\/(stream\/)?(\w{8})(?:\/(\w+)(?:\/(\w+))?)?$/);
    const game = m ? this.games.get(m[2]!) : undefined;
    if (!m || !game) return json(res, 404, { error: "Not found" });
    if (m[1]) return this.stream(res, game);
    const [action, arg] = [m[3], m[4]];
    let result: { status: number; body: unknown };
    if (action === "move") result = this.move(game, arg!, true);
    else if (action === "resign") result = this.end(game, "resign", other(game.user));
    else if (action === "abort") result = game.moves.length < 2 ? this.end(game, "aborted") : { status: 400, body: { error: "This game can't be aborted" } };
    else if (action === "takeback") result = this.takeback(game);
    else result = { status: 404, body: { error: "Not found" } };
    if (respond) return respond();
    json(res, result.status, result.body);
  }

  private challenge(form: URLSearchParams): { status: number; body: unknown } {
    const level = Number(form.get("level"));
    if (!(level >= 1 && level <= 8)) return { status: 400, body: { error: { level: ["level is required"] } } };
    const color = (form.get("color") ?? "random") === "black" ? "black" : "white"; // "random" is white here
    const initialFen = form.get("fen") ?? "startpos";
    const chess = initialFen === "startpos" ? new Chess() : new Chess(initialFen);
    const id = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8);
    const game: FakeGame = { id, aiLevel: level, user: color, initialFen, chess, moves: [], status: "started", streams: new Set() };
    this.games.set(id, game);
    this.scheduleAi(game);
    return { status: 201, body: { id, fullId: id + "abcd", player: color, status: { id: 20, name: "started" } } };
  }

  private stream(res: ServerResponse, game: FakeGame): void {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const ai = { aiLevel: game.aiLevel };
    const human = { id: "tester", name: "Tester" };
    res.write(
      JSON.stringify({
        type: "gameFull",
        id: game.id,
        initialFen: game.initialFen,
        white: game.user === "white" ? human : ai,
        black: game.user === "black" ? human : ai,
        state: state(game),
      }) + "\n",
    );
    if (!live(game)) return void res.end();
    game.streams.add(res);
    res.on("close", () => game.streams.delete(res));
  }

  private move(game: FakeGame, uci: string, byUser: boolean): { status: number; body: unknown } {
    if (!live(game)) return { status: 400, body: { error: "Not your turn, or game already over" } };
    const toMove = game.chess.turn() === "w" ? "white" : "black";
    if (byUser !== (toMove === game.user)) return { status: 400, body: { error: "Not your turn, or game already over" } };
    let move: Move;
    try {
      move = game.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      return { status: 400, body: { error: `Piece on ${uci.slice(0, 2)} cannot move to ${uci.slice(2, 4)}` } };
    }
    game.moves.push(lichessUci(move));
    if (game.chess.isCheckmate()) game.status = "mate", game.winner = toMove;
    else if (game.chess.isStalemate()) game.status = "stalemate";
    else if (game.chess.isDraw()) game.status = "draw";
    this.broadcast(game);
    if (byUser) this.scheduleAi(game);
    return { status: 200, body: { ok: true } };
  }

  private scheduleAi(game: FakeGame): void {
    const toMove = game.chess.turn() === "w" ? "white" : "black";
    if (!live(game) || toMove === game.user) return;
    setTimeout(() => {
      if (!live(game)) return;
      const moves = game.chess.moves({ verbose: true });
      // Predictable: castle when it can (to exercise king-takes-rook), otherwise the first move.
      const pick = moves.find((m) => m.isKingsideCastle() || m.isQueensideCastle()) ?? moves[0]!;
      this.move(game, pick.from + pick.to + (pick.promotion ?? ""), false);
    }, this.aiDelayMs);
  }

  private takeback(game: FakeGame): { status: number; body: unknown } {
    if (!this.acceptTakebacks) return { status: 200, body: { ok: true } };
    const toMove = game.chess.turn() === "w" ? "white" : "black";
    const back = toMove === game.user ? 2 : 1;
    for (let i = 0; i < back && game.moves.length; i++) {
      game.chess.undo();
      game.moves.pop();
    }
    this.broadcast(game);
    return { status: 200, body: { ok: true } };
  }

  private end(game: FakeGame, status: string, winner?: "white" | "black"): { status: number; body: unknown } {
    if (!live(game)) return { status: 400, body: { error: "Game already over" } };
    game.status = status;
    game.winner = winner;
    this.broadcast(game);
    return { status: 200, body: { ok: true } };
  }

  private broadcast(game: FakeGame): void {
    for (const s of game.streams) {
      s.write(JSON.stringify(state(game)) + "\n");
      if (!live(game)) s.end();
    }
  }

  private exchange(res: ServerResponse, form: URLSearchParams): void {
    const grant = this.codes.get(form.get("code") ?? "");
    if (!grant) return json(res, 400, { error: "invalid_grant", error_description: "unknown code" });
    this.codes.delete(form.get("code")!);
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== grant.challenge) return json(res, 400, { error: "invalid_grant", error_description: "hash of code_verifier does not match code_challenge" });
    if (form.get("redirect_uri") !== grant.redirectUri || form.get("client_id") !== grant.clientId) {
      return json(res, 400, { error: "invalid_grant", error_description: "mismatch" });
    }
    const token = `lip_${randomBytes(10).toString("hex")}`;
    this.tokens.add(token);
    json(res, 200, { token_type: "Bearer", access_token: token, expires_in: 31536000 });
  }
}

function lichessUci(move: Move): string {
  if (move.isKingsideCastle()) return move.from + "h" + move.from[1];
  if (move.isQueensideCastle()) return move.from + "a" + move.from[1];
  return move.from + move.to + (move.promotion ?? "");
}

function state(game: FakeGame) {
  return { type: "gameState", moves: game.moves.join(" "), wtime: 0, btime: 0, winc: 0, binc: 0, status: game.status, ...(game.winner ? { winner: game.winner } : {}) };
}

function playing(game: FakeGame) {
  const toMove = game.chess.turn() === "w" ? "white" : "black";
  return { gameId: game.id, fullId: game.id + "abcd", color: game.user, isMyTurn: toMove === game.user, opponent: { id: null, username: `A.I. level ${game.aiLevel}`, ai: game.aiLevel } };
}

function live(game: FakeGame): boolean {
  return game.status === "started" || game.status === "created";
}

function other(color: "white" | "black"): "white" | "black" {
  return color === "white" ? "black" : "white";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => resolve(data));
  });
}

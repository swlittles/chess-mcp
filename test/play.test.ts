import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers/harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const boardOf = (text: string) => text.split("```text\n")[1]!.split("\n```")[0]!;

describe("over MCP", () => {
  it("lists the tools and tells the agent to ask for a color", async () => {
    h = await makeHarness();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["find_openings", "lichess_login", "lichess_logout", "lichess_status", "list_games", "make_move", "new_game", "resign", "show_board", "takeback"].sort(),
    );
    const newGame = tools.find((t) => t.name === "new_game")!;
    expect(newGame.inputSchema.required).toEqual(["color"]);
    expect(newGame.description).toMatch(/ask them/);
    expect(h.client.getInstructions()).toMatch(/If the user hasn't said which color/);
    expect(h.client.getInstructions()).toMatch(/don't suggest moves/);
  });
});

describe("playing", () => {
  it("starts a game as White and plays a move", async () => {
    h = await makeHarness();
    const start = await h.call("new_game", { color: "white", level: 2 });
    expect(start.isError).toBe(false);
    expect(start.text).toContain("You're playing White.");
    expect(start.text).toContain("Your move (White).");
    expect(boardOf(start.text).split("\n")[8]).toBe("1  R  N  B  Q  K  B  N  R  1");

    const move = await h.call("make_move", { move: "e4" });
    expect(move.isError).toBe(false);
    expect(move.text).toMatch(/You played e4\. The Lichess AI played \w+/);
    expect(move.text).toMatch(/Moves: 1\. e4 \w+/);
    expect(move.text).toContain("Your move (White).");
    expect(move.text).toMatch(/Game: http:\/\/127\.0\.0\.1:\d+\/\w{8}$/m);
  });

  it("waits for the AI's first move when the user is Black, and draws the board from Black's side", async () => {
    h = await makeHarness();
    const start = await h.call("new_game", { color: "black" });
    expect(start.text).toMatch(/The Lichess AI played \w+\./);
    expect(start.text).toContain("Your move (Black).");
    expect(boardOf(start.text).split("\n")[0]).toBe("   h  g  f  e  d  c  b  a");
    expect(start.text).toMatch(/\/black$/m);
  });

  it("rejects an illegal move without sending it", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    const result = await h.call("make_move", { move: "Ke2" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/isn't a legal move here. Legal moves: .*e4/);
    expect(h.fake.countRequests("POST", /\/move\//)).toBe(0);
  });

  it("starts from an opening's position", async () => {
    h = await makeHarness();
    const start = await h.call("new_game", { color: "white", opening: "najdorf" });
    expect(start.text).toContain("Starting from Sicilian Defense: Najdorf Variation (B90): 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6");
    expect(start.text).toContain("Opening: Sicilian Defense: Najdorf Variation (B90)");
    expect(start.text).toContain("Your move (White).");
    const move = await h.call("make_move", { move: "Be3" });
    expect(move.text).toMatch(/Moves: 6\. Be3 \w+/);
  });

  it("points out other openings an ambiguous name matched", async () => {
    h = await makeHarness();
    const start = await h.call("new_game", { color: "black", opening: "kings indian" });
    expect(start.text).toMatch(/also matches King's Indian (Defense|Attack)/);
  });

  it("reads castling the way Lichess writes it", async () => {
    h = await makeHarness();
    // Four Knights, Italian (C50): White to move, and the fake AI castles whenever it can,
    // which Lichess sends as king-takes-rook (e1h1).
    const start = await h.call("new_game", { color: "black", opening: "C50" });
    expect(start.text).toContain("The Lichess AI played O-O.");
    expect(start.text).toContain("Moves: 5. O-O");
    expect(start.text).not.toContain("also matches");
    const move = await h.call("make_move", { move: "0-0" });
    expect(move.text).toMatch(/Moves: 5\. O-O O-O 6\. \S+/);
  });

  it("finds openings without a Lichess account", async () => {
    h = await makeHarness({ token: null });
    const result = await h.call("find_openings", { query: "caro kann", limit: 3 });
    expect(result.text).toContain("Caro-Kann Defense (B10): 1. e4 c6. White to move.");
    expect(h.fake.requests).toEqual([]);
  });

  it("lists games and resigns the current one", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    await h.call("make_move", { move: "d4" });
    expect((await h.call("list_games")).text).toMatch(/\(current\): you're White vs AI level 3, your move/);
    const resigned = await h.call("resign");
    expect(resigned.text).toContain("You resigned. The Lichess AI wins.");
    expect((await h.call("list_games")).text).toContain("No games against the Lichess AI in progress");
    expect((await h.call("make_move", { move: "e4" })).text).toContain("There's no game in progress");
  });

  it("aborts instead of resigning before the game has really started", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    expect((await h.call("resign")).text).toContain("The game was aborted.");
  });

  it("takes back a move", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    await h.call("make_move", { move: "e4" });
    const back = await h.call("takeback");
    expect(back.text).toContain("Takeback accepted.");
    expect(back.text).toContain("Moves: none yet");
  });

  it("asks for a game ID when several are in progress", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    const second = await h.call("new_game", { color: "white" });
    const id = second.text.match(/Game: \S+\/(\w{8})/)![1]!;
    h.app.store.update((d) => delete d.current);
    expect((await h.call("show_board")).text).toMatch(/There are 2 games in progress/);
    expect((await h.call("show_board", { game_id: `${h.fake.url}/${id}` })).isError).toBe(false);
  });
});

describe("resilience", () => {
  it("retries a stream that fails to open", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    h.fake.fail(/\/stream\//, 502);
    expect((await h.call("show_board")).isError).toBe(false);
  });

  it("doesn't play a move twice when the answer is lost", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    h.fake.fail(/\/move\//, "apply-then-drop");
    const result = await h.call("make_move", { move: "e4" });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/Moves: 1\. e4 \w+$/m);
    expect(h.fake.countRequests("POST", /\/move\//)).toBe(1);
  });

  it("sends a move again when it never arrived", async () => {
    h = await makeHarness();
    await h.call("new_game", { color: "white" });
    h.fake.fail(/\/move\//, "drop");
    const result = await h.call("make_move", { move: "e4" });
    expect(result.isError).toBe(false);
    expect(h.fake.countRequests("POST", /\/move\//)).toBe(2);
  });

  it("doesn't start a second game when the answer to new_game is lost", async () => {
    h = await makeHarness();
    h.fake.fail(/\/challenge\/ai/, "apply-then-drop");
    const result = await h.call("new_game", { color: "white" });
    expect(result.isError).toBe(false);
    expect(h.fake.games.size).toBe(1);
  });

  it("waits a minute after a 429 without sending more requests", async () => {
    h = await makeHarness();
    h.fake.fail(/\/account\/playing/, 429);
    const first = await h.call("list_games");
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/rate limiting requests. Wait (59|60) seconds/);
    const before = h.fake.requests.length;
    expect((await h.call("new_game", { color: "white" })).text).toMatch(/Wait \d+ seconds/);
    expect(h.fake.requests.length).toBe(before);
  });

  it("sends one request at a time", async () => {
    h = await makeHarness();
    await Promise.all([h.call("list_games"), h.call("list_games"), h.call("lichess_status")]);
    expect(h.fake.maxConcurrent).toBe(1);
  });

  it("says what failed when Lichess is down", async () => {
    h = await makeHarness();
    h.fake.fail(/\/account\/playing/, 503, 5);
    const result = await h.call("list_games");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Lichess had a server error (503");
    expect(h.fake.countRequests("GET", /\/account\/playing/)).toBe(3);
  });
});

describe("signing in", () => {
  it("returns a sign-in link, then plays once the user approves", async () => {
    h = await makeHarness({ token: null });
    const first = await h.call("new_game", { color: "white" });
    expect(first.isError).toBe(true);
    expect(first.text).toContain("Lichess isn't connected yet.");
    const link = first.text.split("\n").find((l) => l.startsWith(h.fake.url + "/oauth?"))!;
    expect(h.opened).toEqual([link]);
    const params = new URL(link).searchParams;
    expect(params.get("scope")).toBe("challenge:write board:play");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const page = await h.fake.approve(link);
    expect(await page.text()).toContain("Signed in to Lichess as <b>Tester</b>");
    expect(h.tokens.token).toMatch(/^lip_/);
    expect((await h.call("new_game", { color: "white" })).isError).toBe(false);
    expect((await h.call("lichess_status")).text).toContain("Connected to Lichess as Tester");
  });

  it("waits for a sign-in in progress instead of failing at once", async () => {
    h = await makeHarness({ token: null });
    const login = await h.call("lichess_login");
    const link = login.text.split("\n").find((l) => l.includes("/oauth?"))!;
    const call = h.call("lichess_status");
    // lichess_status doesn't wait, but lichess_login does:
    expect((await call).text).toContain("A sign-in is waiting");
    const waiting = h.call("lichess_login");
    await new Promise((r) => setTimeout(r, 50));
    await h.fake.approve(link);
    expect((await waiting).text).toContain("Connected to Lichess as Tester");
  });

  it("reports a cancelled sign-in", async () => {
    h = await makeHarness({ token: null });
    const login = await h.call("lichess_login");
    const link = login.text.split("\n").find((l) => l.includes("/oauth?"))!;
    const page = await h.fake.deny(link);
    expect(page.status).toBe(400);
    expect(h.tokens.token).toBeUndefined();
    expect(h.app.login.current).toBeUndefined();
  });

  it("forgets a revoked token and asks to sign in again", async () => {
    h = await makeHarness({ token: "lip_revoked" });
    const result = await h.call("list_games");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Lichess rejected the token");
    expect(result.text).toContain("/oauth?");
    expect(h.tokens.token).toBeUndefined();
  });

  it("doesn't touch a token from LICHESS_TOKEN", async () => {
    h = await makeHarness({ token: null, env: { LICHESS_TOKEN: "lip_bad" } });
    const result = await h.call("list_games");
    expect(result.text).toContain("LICHESS_TOKEN");
    expect(result.text).not.toContain("/oauth?");
  });

  it("signs out and revokes the token", async () => {
    h = await makeHarness();
    expect((await h.call("lichess_logout")).text).toContain("Signed out");
    expect(h.tokens.token).toBeUndefined();
    expect(h.fake.tokens.has("lip_valid")).toBe(false);
  });
});

import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { renderBoard } from "../src/chess/board.js";
import { IllegalMove, numberedMoves, parseMove, replay } from "../src/chess/game.js";
import { epdOf, findOpenings, openingAt } from "../src/chess/openings.js";

describe("parseMove", () => {
  const after = (...moves: string[]) => {
    const chess = new Chess();
    for (const m of moves) chess.move(m);
    return chess;
  };

  it.each([
    ["Nf3", "Nf3"],
    ["nf3", "Nf3"],
    ["g1f3", "Nf3"],
    ["g1-f3", "Nf3"],
    ["g1 f3", "Nf3"],
    ["e4!", "e4"],
    ["e2e4", "e4"],
  ])("reads %s from the start", (input, san) => {
    expect(parseMove(new Chess(), input).san).toBe(san);
  });

  it("reads castling in its usual spellings", () => {
    const ready = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"];
    for (const input of ["O-O", "0-0", "o-o", "OO", "e1g1"]) {
      expect(parseMove(after(...ready), input).san).toBe("O-O");
    }
  });

  it("tells a b-pawn capture from a bishop move", () => {
    const chess = after("b4", "c5");
    expect(parseMove(chess, "bxc5").san).toBe("bxc5");
  });

  it("reads promotions", () => {
    const chess = new Chess("8/4P3/8/8/8/8/k7/4K3 w - - 0 1");
    expect(parseMove(new Chess(chess.fen()), "e8=Q").san).toBe("e8=Q");
    expect(parseMove(new Chess(chess.fen()), "e7e8n").san).toBe("e8=N");
  });

  it("rejects an illegal move and lists the legal ones", () => {
    expect(() => parseMove(new Chess(), "Ke2")).toThrow(IllegalMove);
    expect(() => parseMove(new Chess(), "Ke2")).toThrow(/Legal moves: .*Nf3/);
  });
});

describe("replay", () => {
  it("understands Lichess's king-takes-rook castling", () => {
    const { chess, moves } = replay("startpos", "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1h1 g8f6");
    expect(moves.map((m) => m.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O", "Nf6"]);
    expect(chess.get("g1")).toEqual({ type: "k", color: "w" });
  });

  it("starts from a FEN", () => {
    const fen = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const { moves, startFen } = replay(fen, "g1f3");
    expect(startFen).toBe(fen);
    expect(numberedMoves(startFen, moves)).toBe("2. Nf3");
  });

  it("numbers moves from a position where Black moves first", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const { moves, startFen } = replay(fen, "c7c5 g1f3 d7d6");
    expect(numberedMoves(startFen, moves)).toBe("1... c5 2. Nf3 d6");
  });
});

describe("renderBoard", () => {
  it("draws from White's side with the last move in brackets", () => {
    const chess = new Chess();
    const move = chess.move("e4");
    const board = renderBoard(chess, { perspective: "white", lastMove: move, style: "letters" });
    const lines = board.split("\n");
    expect(lines[0]).toBe("   a  b  c  d  e  f  g  h");
    expect(lines[1]).toBe("8  r  n  b  q  k  b  n  r  8");
    expect(lines[5]).toBe("4  .  .  .  . [P] .  .  .  4");
    expect(lines[7]).toBe("2  P  P  P  P [.] P  P  P  2");
  });

  it("flips for Black", () => {
    const board = renderBoard(new Chess(), { perspective: "black", style: "letters" }).split("\n");
    expect(board[0]).toBe("   h  g  f  e  d  c  b  a");
    expect(board[1]).toBe("1  R  N  B  K  Q  B  N  R  1");
  });

  it("uses chess symbols with a legend by default", () => {
    const board = renderBoard(new Chess(), { perspective: "white" });
    expect(board).toContain("8  ♜  ♞  ♝  ♛  ♚  ♝  ♞  ♜  8");
    expect(board).toContain("White ♔♕♖♗♘♙");
  });
});

describe("openings", () => {
  it.each([
    ["najdorf", "Sicilian Defense: Najdorf Variation"],
    ["sicilian", "Sicilian Defense"],
    ["kings indian defense", "King's Indian Defense"],
    ["King's Indian Defence", "King's Indian Defense"],
    ["london", "London System"],
    ["queens gambit declined", "Queen's Gambit Declined"],
    ["caro kann", "Caro-Kann Defense"],
    ["ruy lopez", "Ruy Lopez"],
  ])("finds %s", (query, name) => {
    expect(findOpenings(query, 1)[0]?.name).toBe(name);
  });

  it("lists both readings of an ambiguous name", () => {
    expect(findOpenings("kings indian", 2).map((o) => o.name).sort()).toEqual(["King's Indian Attack", "King's Indian Defense"]);
  });

  it("finds by ECO code", () => {
    expect(findOpenings("B90").map((o) => o.name)).toContain("Sicilian Defense: Najdorf Variation");
  });

  it("returns nothing for nonsense", () => {
    expect(findOpenings("zzzz")).toEqual([]);
  });

  it("names the opening of a position", () => {
    const { chess } = replay("startpos", "e2e4 c7c5");
    expect(openingAt(epdOf(chess.fen()))?.name).toBe("Sicilian Defense");
  });
});

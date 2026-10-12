// A game position rebuilt from what Lichess sends: the starting FEN and the moves in UCI.

import { Chess, type Move } from "chess.js";

export type Color = "white" | "black";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export class IllegalMove extends Error {}

export interface Position {
  chess: Chess;
  /** Every move played, in order. */
  moves: Move[];
  startFen: string;
}

/**
 * Replays a game. Lichess writes castling as the king taking its own rook (e1h1, e8a8), which
 * chess.js doesn't understand, so those moves are turned back into king moves (e1g1, e8c8).
 */
export function replay(initialFen: string | undefined, uciMoves: string): Position {
  const startFen = !initialFen || initialFen === "startpos" ? START_FEN : initialFen;
  const chess = new Chess(startFen);
  const moves: Move[] = [];
  for (const uci of uciMoves.split(" ").filter(Boolean)) {
    moves.push(playUci(chess, uci));
  }
  return { chess, moves, startFen };
}

export function playUci(chess: Chess, uci: string): Move {
  const from = uci.slice(0, 2);
  let to = uci.slice(2, 4);
  const promotion = uci[4];
  const piece = chess.get(from as never);
  const target = chess.get(to as never);
  if (piece?.type === "k" && target?.type === "r" && target.color === piece.color) {
    to = (to[0]! > from[0]! ? "g" : "c") + to[1]!;
  }
  try {
    return chess.move({ from, to, promotion });
  } catch {
    throw new IllegalMove(`Lichess sent a move that isn't legal here: ${uci}`);
  }
}

/** Standard UCI for a move (e1g1 for castling), which is what the Board API accepts. */
export function uciOf(move: Move): string {
  return move.from + move.to + (move.promotion ?? "");
}

/**
 * Reads the user's move in SAN (Nf3, exd5, O-O, e8=Q), UCI (g1f3, e7e8q) or with separators
 * (g1-f3, "g1 f3"). Throws IllegalMove with the legal moves when it isn't one.
 */
export function parseMove(chess: Chess, input: string): Move {
  const raw = input.trim().replace(/[!?+#]+$/g, "");
  const attempts = new Set<string>([raw]);
  // Castling written with zeros or lowercase letters.
  if (/^[0o]-?[0o](-?[0o])?$/i.test(raw)) attempts.add(raw.replace(/[0o]/gi, "O").replace(/O(?=O)/g, "O-"));
  // Coordinates with a separator: e2-e4, e2 e4, e2xe4.
  const coords = raw.toLowerCase().match(/^([a-h][1-8])\s*[-x\s]?\s*([a-h][1-8])\s*=?([qrbn])?$/);
  if (coords) attempts.add(coords[1]! + coords[2]! + (coords[3] ?? ""));
  // A lowercase piece letter: nf3 → Nf3 (but not b-pawn moves like bxc3, which are tried as written first).
  if (/^[nrqk][a-h1-8x]/.test(raw)) attempts.add(raw[0]!.toUpperCase() + raw.slice(1));
  if (/^b[a-h]?x?[a-h][1-8]/.test(raw)) attempts.add("B" + raw.slice(1));

  for (const attempt of attempts) {
    const uci = attempt.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
    try {
      return uci ? chess.move({ from: uci[1]!, to: uci[2]!, promotion: uci[3] }) : chess.move(attempt, { strict: false });
    } catch {
      // try the next reading
    }
  }
  const legal = chess.moves();
  throw new IllegalMove(
    legal.length
      ? `"${input}" isn't a legal move here. Legal moves: ${legal.join(", ")}.`
      : `"${input}" can't be played: the game is over.`,
  );
}

export function turnColor(chess: Chess): Color {
  return chess.turn() === "w" ? "white" : "black";
}

/** "1. e4 e5 2. Nf3", starting from the right move number and side for games from a position. */
export function numberedMoves(startFen: string, moves: readonly Move[]): string {
  const [, side, , , , full] = startFen.split(" ");
  let number = Number(full) || 1;
  let white = side !== "b";
  const parts: string[] = [];
  moves.forEach((move, i) => {
    if (white) parts.push(`${number}. ${move.san}`);
    else parts.push(i === 0 ? `${number}... ${move.san}` : move.san);
    if (!white) number++;
    white = !white;
  });
  return parts.join(" ");
}

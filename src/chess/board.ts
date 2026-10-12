// The text board shown after every move. Plain text so it works in every client, terminal included.

import type { Chess, Move } from "chess.js";
import type { Color } from "./game.js";

export type BoardStyle = "unicode" | "letters";

const GLYPHS: Record<string, string> = {
  K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};

/**
 * Draws the board from `perspective`'s side. The last move's squares are in brackets, e.g. [·] and
 * [♘], so it's visible without colors. In dark themes the outlined and filled glyphs can look
 * swapped, so the unicode board ends with a legend.
 */
export function renderBoard(chess: Chess, options: { perspective: Color; lastMove?: Move; style?: BoardStyle }): string {
  const style = options.style ?? "unicode";
  const marked = new Set<string>(options.lastMove ? [options.lastMove.from, options.lastMove.to] : []);
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  if (options.perspective === "black") {
    files.reverse();
    ranks.reverse();
  }
  const header = "   " + files.join("  ");
  const rows = ranks.map((rank) => {
    const cells = files.map((file) => {
      const square = `${file}${rank}`;
      const piece = chess.get(square as never);
      const letter = piece ? (piece.color === "w" ? piece.type.toUpperCase() : piece.type) : "";
      const symbol = !piece ? (style === "letters" ? "." : "·") : style === "letters" ? letter : GLYPHS[letter]!;
      return marked.has(square) ? `[${symbol}]` : ` ${symbol} `;
    });
    return `${rank} ${cells.join("")} ${rank}`;
  });
  const lines = [header, ...rows, header];
  if (style === "unicode") lines.push("", "White ♔♕♖♗♘♙   Black ♚♛♜♝♞♟");
  return lines.join("\n");
}

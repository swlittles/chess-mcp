// The board as a picture: an SVG with Lichess's colors and the Cburnett pieces, turned into a PNG.

import { Resvg } from "@resvg/resvg-js";
import type { Chess, Move } from "chess.js";
import type { Color } from "./game.js";
import { PIECES } from "./pieces.js";

const SQUARE = 64;
const LIGHT = "#f0d9b5";
const DARK = "#b58863";
const LAST_MOVE = "#9bc700";

export interface BoardImageOptions {
  perspective: Color;
  lastMove?: Move;
  /** Width and height of the PNG in pixels. */
  size?: number;
}

export function boardSvg(chess: Chess, options: BoardImageOptions): string {
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  if (options.perspective === "black") {
    files.reverse();
    ranks.reverse();
  }
  const marked = new Set<string>(options.lastMove ? [options.lastMove.from, options.lastMove.to] : []);
  const checked = chess.isCheck() ? chess.turn() : undefined;
  const parts: string[] = [];

  ranks.forEach((rank, row) => {
    files.forEach((file, col) => {
      const square = `${file}${rank}`;
      const x = col * SQUARE;
      const y = row * SQUARE;
      const light = isLight(file, rank);
      parts.push(`<rect x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="${light ? LIGHT : DARK}"/>`);
      if (marked.has(square)) parts.push(`<rect x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="${LAST_MOVE}" fill-opacity="0.41"/>`);
      const piece = chess.get(square as never);
      if (piece?.type === "k" && piece.color === checked) {
        parts.push(`<rect x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="url(#check)"/>`);
      }
      if (piece) {
        parts.push(`<g transform="translate(${x} ${y}) scale(${SQUARE / 45})">${PIECES[piece.color + piece.type.toUpperCase()]}</g>`);
      }
      // Coordinates inside the edge squares, in the other square color, as on lichess.org.
      const ink = light ? DARK : LIGHT;
      if (col === 0) parts.push(label(x + 3, y + 14, String(rank), ink, "start"));
      if (row === 7) parts.push(label(x + SQUARE - 3, y + SQUARE - 4, file, ink, "end"));
    });
  });

  const size = SQUARE * 8;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<defs><radialGradient id="check"><stop offset="0" stop-color="#ff0000"/><stop offset="0.25" stop-color="#e70000"/><stop offset="0.9" stop-color="#a90000" stop-opacity="0"/></radialGradient></defs>`,
    ...parts,
    `</svg>`,
  ].join("");
}

export function boardPng(chess: Chess, options: BoardImageOptions): Buffer {
  const svg = boardSvg(chess, options);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.size ?? 512 },
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
  });
  return resvg.render().asPng();
}

function isLight(file: string, rank: number): boolean {
  return (file.charCodeAt(0) - 97 + rank) % 2 === 0;
}

function label(x: number, y: number, text: string, fill: string, anchor: "start" | "end"): string {
  return `<text x="${x}" y="${y}" font-family="Helvetica, Arial, 'DejaVu Sans', sans-serif" font-size="13" font-weight="700" fill="${fill}" text-anchor="${anchor}">${text}</text>`;
}

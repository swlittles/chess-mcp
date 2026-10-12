// The Lichess opening list (data/openings.tsv, CC0): lookup by name or ECO code, and naming the
// opening a game is in.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Opening {
  eco: string;
  name: string;
  /** Numbered SAN, e.g. "1. e4 c5 2. Nf3". */
  pgn: string;
  uci: string[];
  /** The position the line ends in: FEN without the move counters. */
  epd: string;
}

let all: Opening[] | undefined;
let byEpd: Map<string, Opening> | undefined;

export function openings(): Opening[] {
  if (!all) {
    const path = fileURLToPath(new URL("../../data/openings.tsv", import.meta.url));
    all = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => {
        const [eco, name, pgn, uci, epd] = line.split("\t") as [string, string, string, string, string];
        return { eco, name, pgn, uci: uci.split(" "), epd };
      });
  }
  return all;
}

/** The opening that ends in this position, if any. Transpositions count. */
export function openingAt(epd: string): Opening | undefined {
  if (!byEpd) {
    byEpd = new Map();
    // Keep the first (shortest) line for a position; later lines reaching it are transpositions.
    for (const o of openings()) if (!byEpd.has(o.epd)) byEpd.set(o.epd, o);
  }
  return byEpd.get(epd);
}

/** FEN position → the EPD key used by the opening list. */
export function epdOf(fen: string): string {
  return fen.split(" ").slice(0, 4).join(" ");
}

/**
 * Openings matching a free-text query ("najdorf", "kings indian", "B90"), best first. For each
 * name only the shortest line is returned, which is the main position of that variation.
 */
export function findOpenings(query: string, limit = 10): Opening[] {
  const q = query.trim();
  if (!q) return [];
  if (/^[A-E]\d\d$/i.test(q)) {
    return dedupe(openings().filter((o) => o.eco === q.toUpperCase())).slice(0, limit);
  }
  const words = tokens(q);
  if (!words.length) return [];
  const scored: { opening: Opening; score: number }[] = [];
  for (const opening of dedupe(openings())) {
    const name = tokens(opening.name);
    if (!words.every((w) => name.some((n) => n.startsWith(w)))) continue;
    // Prefer exact word matches, matches in the family name (before the colon), and short lines.
    const family = tokens(opening.name.split(":")[0]!);
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 2;
      if (family.some((n) => n.startsWith(w))) score += 3;
    }
    score -= name.length * 0.5 + opening.uci.length * 0.1;
    scored.push({ opening, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.opening);
}

function dedupe(list: Opening[]): Opening[] {
  const seen = new Map<string, Opening>();
  for (const o of list) {
    const prev = seen.get(o.name);
    if (!prev || o.uci.length < prev.uci.length) seen.set(o.name, o);
  }
  return [...seen.values()];
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/defence/g, "defense")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

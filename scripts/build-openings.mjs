#!/usr/bin/env node
// Rebuilds data/openings.tsv from the Lichess opening list (github.com/lichess-org/chess-openings,
// CC0). Adds the moves in UCI and the position each line ends in (EPD), so the server can look up
// openings without replaying thousands of lines at startup.
//
//   npm run openings:update                 # download the latest list from GitHub
//   node scripts/build-openings.mjs <dir>   # or use a.tsv … e.tsv from a local folder

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Chess } from "chess.js";

const SOURCE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master";
const dir = process.argv[2];

const rows = [];
for (const file of ["a", "b", "c", "d", "e"].map((l) => `${l}.tsv`)) {
  const text = dir ? readFileSync(join(dir, file), "utf8") : await (await fetch(`${SOURCE}/${file}`)).text();
  const [header, ...lines] = text.trim().split("\n");
  if (header !== "eco\tname\tpgn") throw new Error(`${file}: unexpected header ${JSON.stringify(header)}`);
  for (const line of lines) {
    const [eco, name, pgn] = line.split("\t");
    if (!/^[A-E]\d\d$/.test(eco ?? "") || !name || !pgn) throw new Error(`${file}: bad line ${JSON.stringify(line)}`);
    const chess = new Chess();
    const uci = [];
    for (const san of pgn.split(/\s+/).filter((t) => !/^\d+\.+$/.test(t))) {
      const move = chess.move(san);
      uci.push(move.from + move.to + (move.promotion ?? ""));
    }
    const epd = chess.fen().split(" ").slice(0, 4).join(" ");
    rows.push([eco, name, pgn, uci.join(" "), epd]);
  }
}

writeFileSync("data/openings.tsv", ["eco\tname\tpgn\tuci\tepd", ...rows.map((r) => r.join("\t"))].join("\n") + "\n");
console.log(`Wrote ${rows.length} openings to data/openings.tsv.`);

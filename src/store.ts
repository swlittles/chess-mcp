// Small notes about the games this server started: which one is current, and the opening a game
// was started from (Lichess only knows the position). The games themselves live on Lichess.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Color } from "./chess/game.js";

export interface GameNote {
  id: string;
  color: Color;
  level: number;
  createdAt: string;
  opening?: { eco: string; name: string; pgn: string };
}

interface Data {
  current?: string;
  games: Record<string, GameNote>;
  account?: { id: string; username: string };
}

export class Store {
  private readonly path: string;

  constructor(private readonly home: string) {
    this.path = join(home, "state.json");
  }

  read(): Data {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as Data;
      return { ...data, games: data.games ?? {} };
    } catch {
      return { games: {} };
    }
  }

  update(change: (data: Data) => void): void {
    const data = this.read();
    change(data);
    // Keep the last 100 games.
    const ids = Object.values(data.games).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((g) => g.id);
    for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete data.games[id];
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.path);
  }
}

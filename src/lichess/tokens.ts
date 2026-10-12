// Where the Lichess token is kept after signing in: the macOS Keychain, or a file only the user can
// read elsewhere. A LICHESS_TOKEN environment variable takes precedence over both.

import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TokenStore {
  load(): Promise<string | undefined>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
  /** Where it's kept, for messages: "the macOS Keychain". */
  readonly where: string;
}

const SERVICE = "chess-mcp";
const ACCOUNT = "lichess";
// Lichess tokens are lip_ followed by letters and digits. Checked before a token goes into a
// `security` command line, so nothing else can.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,200}$/;

export function defaultTokenStore(home: string): TokenStore {
  return process.platform === "darwin" ? new KeychainStore() : new FileStore(home);
}

export class KeychainStore implements TokenStore {
  readonly where = "the macOS Keychain";

  load(): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], (error, stdout) => {
        resolve(error ? undefined : stdout.trim() || undefined);
      });
    });
  }

  save(token: string): Promise<void> {
    if (!TOKEN_SHAPE.test(token)) return Promise.reject(new Error("Lichess returned a token in an unexpected format."));
    // Through stdin rather than arguments, so the token never shows up in the process list.
    return new Promise((resolve, reject) => {
      const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Couldn't save the token in the Keychain: ${stderr.trim() || `exit ${code}`}`))));
      child.stdin.end(`add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "chess-mcp Lichess token" -w ${token}\n`);
    });
  }

  clear(): Promise<void> {
    return new Promise((resolve) => execFile("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], () => resolve()));
  }
}

export class FileStore implements TokenStore {
  readonly where: string;
  private readonly path: string;

  constructor(private readonly home: string) {
    this.path = join(home, "lichess-token");
    this.where = this.path;
  }

  async load(): Promise<string | undefined> {
    try {
      return readFileSync(this.path, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async save(token: string): Promise<void> {
    if (!TOKEN_SHAPE.test(token)) throw new Error("Lichess returned a token in an unexpected format.");
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, token + "\n", { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  async clear(): Promise<void> {
    rmSync(this.path, { force: true });
  }
}

export class MemoryStore implements TokenStore {
  readonly where = "memory";
  constructor(public token?: string) {}
  async load() {
    return this.token;
  }
  async save(token: string) {
    this.token = token;
  }
  async clear() {
    this.token = undefined;
  }
}

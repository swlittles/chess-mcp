import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { App } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { MemoryStore } from "../../src/lichess/tokens.js";
import { createServer } from "../../src/server.js";
import { FakeLichess } from "./fake-lichess.js";

export interface Harness {
  fake: FakeLichess;
  app: App;
  tokens: MemoryStore;
  client: Client;
  /** Sign-in links the server tried to open in a browser. */
  opened: string[];
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; images: { data: string; mimeType: string }[] }>;
  close(): Promise<void>;
}

export async function makeHarness(options: { token?: string | null; env?: Record<string, string> } = {}): Promise<Harness> {
  const fake = await new FakeLichess().start();
  const tokens = new MemoryStore(options.token === null ? undefined : (options.token ?? "lip_valid"));
  const opened: string[] = [];
  const config = loadConfig({ LICHESS_URL: fake.url, CHESS_MCP_HOME: mkdtempSync(join(tmpdir(), "chess-mcp-")), CHESS_BOARD_STYLE: "letters", ...options.env });
  const app = new App(config, {
    tokens,
    openBrowser: (url) => opened.push(url),
    client: { backoffMs: [5, 5], timeoutMs: 2_000 },
    replyTimeoutMs: 2_000,
  });
  const server = createServer(app, { loginWaitMs: 300 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    fake,
    app,
    tokens,
    client,
    opened,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const images = content.filter((c) => c.type === "image").map((c) => ({ data: c.data!, mimeType: c.mimeType! }));
      return { text, isError: Boolean(result.isError), images };
    },
    async close() {
      app.login.cancel();
      await client.close();
      await fake.close();
    },
  };
}

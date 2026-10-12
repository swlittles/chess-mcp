// Sign in with Lichess (OAuth 2 with PKCE). Lichess accepts unregistered public clients, so there's
// no app to register and no secret: the server listens on 127.0.0.1 for the redirect, swaps the
// code for a token (valid about a year) and saves it.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const CLIENT_ID = "chess-mcp";
export const SCOPES = ["challenge:write", "board:play"];
const LOGIN_TTL_MS = 10 * 60_000;

export interface Account {
  id: string;
  username: string;
}

export interface LoginOptions {
  lichessUrl: string;
  /** Saves the token and returns the account it belongs to. */
  complete: (token: string) => Promise<Account>;
  openBrowser?: (url: string) => void;
  fetch?: typeof fetch;
}

export interface PendingLogin {
  url: string;
  /** Settles when the user approves (or denies) in the browser, or the link expires. */
  done: Promise<Account>;
  expiresAt: number;
}

/** One sign-in at a time: starting again while one is waiting returns the same link. */
export class LoginFlow {
  private pending?: PendingLogin & { server: Server };

  constructor(private readonly options: LoginOptions) {}

  get current(): PendingLogin | undefined {
    return this.pending;
  }

  async start(): Promise<PendingLogin> {
    if (this.pending && Date.now() < this.pending.expiresAt) return this.pending;

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const url =
      `${this.options.lichessUrl}/oauth?` +
      new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        code_challenge_method: "S256",
        code_challenge: challenge,
        scope: SCOPES.join(" "),
        state,
      }).toString().replace(/\+/g, "%20");

    let settle!: { resolve: (a: Account) => void; reject: (e: Error) => void };
    const done = new Promise<Account>((resolve, reject) => (settle = { resolve, reject }));
    done.catch(() => {}); // a rejection nobody awaits mustn't crash the server
    const finish = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (this.pending?.server === server) this.pending = undefined;
    };
    const timer = setTimeout(() => {
      finish();
      settle.reject(new Error("The sign-in link expired after 10 minutes. Start again."));
    }, LOGIN_TTL_MS);
    timer.unref();

    server.on("request", (req, res) => {
      const params = new URL(req.url ?? "/", redirectUri).searchParams;
      if (!req.url?.startsWith("/callback") || params.get("state") !== state) {
        res.writeHead(404).end();
        return;
      }
      const page = (status: number, title: string, body: string) =>
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(htmlPage(title, body));
      const error = params.get("error");
      if (error) {
        page(400, "Not connected", `Lichess said: ${escapeHtml(params.get("error_description") ?? error)}. You can close this tab.`);
        finish();
        settle.reject(new Error(error === "access_denied" ? "Sign-in was cancelled on Lichess." : `Lichess sign-in failed: ${error}.`));
        return;
      }
      this.exchange(params.get("code") ?? "", verifier, redirectUri)
        .then((token) => this.options.complete(token))
        .then(
          (account) => {
            page(200, "Connected", `Signed in to Lichess as <b>${escapeHtml(account.username)}</b>. Close this tab and go back to your chat.`);
            finish();
            settle.resolve(account);
          },
          (err: Error) => {
            page(500, "Not connected", `${escapeHtml(err.message)} Close this tab and try again.`);
            finish();
            settle.reject(err);
          },
        );
    });

    this.pending = { url, done, expiresAt: Date.now() + LOGIN_TTL_MS, server };
    (this.options.openBrowser ?? openInBrowser)(url);
    return this.pending;
  }

  cancel(): void {
    this.pending?.server.close();
    this.pending = undefined;
  }

  private async exchange(code: string, verifier: string, redirectUri: string): Promise<string> {
    const response = await (this.options.fetch ?? fetch)(`${this.options.lichessUrl}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: CLIENT_ID }),
    });
    const json = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!response.ok || !json.access_token) {
      throw new Error(`Lichess didn't issue a token (${json.error_description ?? json.error ?? response.status}).`);
    }
    return json.access_token;
  }
}

/** Opens a URL in the default browser. Best effort: the link is also shown in the chat. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser available; the user opens the link themselves
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title} · chess-mcp</title>
<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;text-align:center;color:#222">
<div style="font-size:48px">♞</div><h1 style="font-weight:600">${title}</h1><p>${body}</p></body>`;
}

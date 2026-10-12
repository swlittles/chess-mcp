// Everything a running server needs: config, the Lichess connection (token, sign-in, client) and
// the game logic.

import type { Config } from "./config.js";
import { LoginFlow, SCOPES, type Account } from "./lichess/auth.js";
import { LichessClient, type ClientOptions } from "./lichess/client.js";
import { defaultTokenStore, type TokenStore } from "./lichess/tokens.js";
import { Play } from "./play.js";
import { Store } from "./store.js";

export interface AppOptions {
  tokens?: TokenStore;
  openBrowser?: (url: string) => void;
  client?: Partial<ClientOptions>;
  replyTimeoutMs?: number;
}

export class App {
  readonly store: Store;
  readonly tokens: TokenStore;
  readonly client: LichessClient;
  readonly login: LoginFlow;
  readonly play: Play;
  /** undefined: not read yet; null: read, and there's none. */
  private token?: string | null;
  private readonly fetch: typeof fetch;

  constructor(
    readonly config: Config,
    options: AppOptions = {},
  ) {
    this.store = new Store(config.home);
    this.fetch = options.client?.fetch ?? globalThis.fetch.bind(globalThis);
    this.tokens = options.tokens ?? defaultTokenStore(config.home);
    this.client = new LichessClient({ baseUrl: config.lichessUrl, token: () => this.currentToken(), ...options.client });
    this.login = new LoginFlow({
      lichessUrl: config.lichessUrl,
      complete: (token) => this.saveToken(token),
      openBrowser: config.openBrowser ? options.openBrowser : () => {},
      fetch: this.fetch,
    });
    this.play = new Play({
      client: this.client,
      store: this.store,
      boardStyle: config.boardStyle,
      defaultLevel: config.defaultLevel,
      replyTimeoutMs: options.replyTimeoutMs,
    });
  }

  async currentToken(): Promise<string | undefined> {
    if (this.config.envToken) return this.config.envToken;
    if (this.token === undefined) this.token = (await this.tokens.load()) ?? null;
    return this.token ?? undefined;
  }

  /** Checks a new token with Lichess, then keeps it. */
  async saveToken(token: string): Promise<Account> {
    const response = await this.fetch(`${this.config.lichessUrl}/api/account`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Lichess didn't accept the new token (${response.status}).`);
    const { id, username } = (await response.json()) as Account;
    await this.tokens.save(token);
    this.token = token;
    this.store.update((d) => (d.account = { id, username }));
    return { id, username };
  }

  /** Forgets a token Lichess rejected, so the next sign-in starts clean. A LICHESS_TOKEN can't be forgotten. */
  async dropRejectedToken(): Promise<void> {
    if (this.config.envToken) return;
    await this.tokens.clear();
    this.token = null;
  }

  async logout(): Promise<string> {
    if (this.config.envToken) {
      return "This server uses the token in the LICHESS_TOKEN environment variable. Remove it from the MCP config to sign out.";
    }
    const token = await this.currentToken();
    if (!token) return "Not signed in to Lichess.";
    // Revoke it on Lichess too. Best effort: signing out locally works either way.
    await this.fetch(`${this.config.lichessUrl}/api/token`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    await this.tokens.clear();
    this.token = null;
    this.store.update((d) => delete d.account);
    return "Signed out of Lichess and revoked the token.";
  }

  async status(): Promise<string> {
    const token = await this.currentToken();
    const pending = this.login.current;
    if (!token) {
      return pending
        ? `Not connected to Lichess. A sign-in is waiting for the user to approve it: ${pending.url}`
        : "Not connected to Lichess. Call lichess_login to sign in.";
    }
    const response = await this.client.request<Account>("GET", "/api/account");
    const source = this.config.envToken ? "the LICHESS_TOKEN environment variable" : this.tokens.where;
    return `Connected to Lichess as ${response.username}. The token is kept in ${source}. Permissions requested: ${SCOPES.join(", ")}.`;
  }
}

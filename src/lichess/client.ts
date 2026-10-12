// HTTP client for the Lichess API. Follows Lichess's rules for API clients: one request at a time,
// and after a 429 wait a full minute before trying again. Requests that are safe to repeat are
// retried with backoff when Lichess or the network has a hiccup.

export class LichessError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
/** No token: the user hasn't signed in. */
export class NotConnected extends LichessError {}
/** Lichess refused the token (revoked, expired, or missing a scope). */
export class TokenRejected extends LichessError {}
export class RateLimited extends LichessError {
  constructor(readonly seconds: number) {
    super(`Lichess is rate limiting requests. Wait ${seconds} seconds, then try again.`, 429);
  }
}
/** Lichess couldn't be reached or kept failing. */
export class Unavailable extends LichessError {}

export interface ClientOptions {
  baseUrl: string;
  token: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Delays between attempts for retryable failures. */
  backoffMs?: number[];
  timeoutMs?: number;
}

export interface RequestOptions {
  form?: Record<string, string | number | undefined>;
  query?: Record<string, string | number | undefined>;
  /** Retry on network errors and 5xx. Only for requests that are safe to repeat. */
  retry?: boolean;
  /** Send the token (default). */
  auth?: boolean;
}

const COOLDOWN_MS = 60_000;

export class LichessClient {
  private queue: Promise<unknown> = Promise.resolve();
  private cooldownUntil = 0;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly backoff: number[];
  private readonly timeoutMs: number;

  constructor(private readonly options: ClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.backoff = options.backoffMs ?? [1_000, 3_000];
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** A JSON request. Requests run one at a time, in order. */
  request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const run = this.queue.then(() => this.send<T>(method, path, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Opens an ndjson stream and yields one object per line, skipping keep-alive blank lines. Streams
   * stay open while other requests run, as the Board API expects. Opening is retried like a GET.
   */
  async openStream(path: string, signal: AbortSignal): Promise<AsyncGenerator<Record<string, unknown>>> {
    const response = await this.withRetries(true, () => this.fetchOnce("GET", path, {}, signal, false));
    if (!response.body) throw new Unavailable("Lichess sent an empty stream.");
    return readLines(response.body, signal);
  }

  private async send<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const response = await this.withRetries(options.retry ?? method === "GET", () =>
      this.fetchOnce(method, path, options, AbortSignal.timeout(this.timeoutMs), true),
    );
    const text = await response.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new Unavailable(`Lichess sent a response that isn't JSON (${response.status}).`);
    }
  }

  private async withRetries(retry: boolean, attempt: () => Promise<Response>): Promise<Response> {
    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (error) {
        const retryable = error instanceof Unavailable;
        if (!retry || !retryable || i >= this.backoff.length) throw error;
        await this.sleep(this.backoff[i]!);
      }
    }
  }

  private async fetchOnce(method: string, path: string, options: RequestOptions, signal: AbortSignal, timed: boolean): Promise<Response> {
    const wait = this.cooldownUntil - this.now();
    if (wait > 0) throw new RateLimited(Math.ceil(wait / 1000));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.auth !== false) {
      const token = await this.options.token();
      if (!token) throw new NotConnected("Lichess isn't connected yet.");
      headers.Authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (options.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(defined(options.form)).toString();
    }
    const query = options.query ? `?${new URLSearchParams(defined(options.query))}` : "";
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl}${path}${query}`, { method, headers, body, signal });
    } catch (error) {
      if (signal.aborted && !timed) throw error; // the caller closed the stream
      const reason = signal.aborted ? `no answer within ${this.timeoutMs / 1000} seconds` : causeOf(error);
      throw new Unavailable(`Couldn't reach Lichess (${reason}).`);
    }
    if (response.ok) return response;

    const detail = await errorDetail(response);
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      this.cooldownUntil = this.now() + (Number.isFinite(after) && after > 0 ? after * 1000 : COOLDOWN_MS);
      throw new RateLimited(Math.ceil((this.cooldownUntil - this.now()) / 1000));
    }
    if (response.status === 401) throw new TokenRejected(`Lichess rejected the token${detail ? ` (${detail})` : ""}.`, 401);
    if (response.status === 403 && /scope/i.test(detail)) throw new TokenRejected(`The Lichess token is missing a permission (${detail}).`, 403);
    if (response.status >= 500) throw new Unavailable(`Lichess had a server error (${response.status}${detail ? `: ${detail}` : ""}).`);
    throw new LichessError(detail || `Lichess answered ${response.status}.`, response.status);
  }
}

async function* readLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) return;
        throw new Unavailable(`The connection to Lichess dropped (${causeOf(error)}).`);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as Record<string, unknown>;
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const error = json.error_description ?? json.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") return Object.values(error).flat().join(" ");
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 200);
}

function defined(values: Record<string, string | number | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
}

function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

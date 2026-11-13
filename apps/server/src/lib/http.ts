import { config } from '../config.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    body: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
}

interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a JSON document with a timeout and a small retry budget for transient failures. */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { timeoutMs = 20_000, retries = 2, headers = {} } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': config.userAgent, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new HttpError(res.status, url, body);
        // Client errors (incl. 429 rate limits and 451 geo blocks) will not improve by retrying now.
        if (res.status < 500) throw err;
        lastErr = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) throw err;
      lastErr = err;
    }
    if (attempt < retries) await sleep(600 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Try several base URLs in order and return the first that answers. */
export async function fetchJsonAny<T>(urls: string[], opts: FetchOpts = {}): Promise<T> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      return await fetchJson<T>(url, { ...opts, retries: opts.retries ?? 1 });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Tiny in-memory TTL cache for on-demand (non persisted) upstream calls. */
export function ttlCache<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let at = 0;
  let pending: Promise<T> | null = null;
  return async () => {
    if (value !== undefined && Date.now() - at < ttlMs) return value;
    if (!pending) {
      pending = load()
        .then((v) => {
          value = v;
          at = Date.now();
          return v;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

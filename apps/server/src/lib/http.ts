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

export class DeadlineError extends Error {}

/**
 * Gives up on a promise that has not settled in time. The abort signal of a request normally does
 * this, but a connection that was open when the computer went to sleep can be left waiting for ever
 * after it wakes; this timer does not depend on the socket.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

interface RequestOpts extends FetchOpts {
  /** Sent as a JSON POST body when given. */
  body?: unknown;
}

/** One request, body included, with a timeout and a small retry budget for transient failures. */
async function request(url: string, opts: RequestOpts): Promise<string> {
  const { timeoutMs = 20_000, retries = 2, headers = {}, body } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { ok, status, text } = await withDeadline(
        (async () => {
          const res = await fetch(url, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'User-Agent': config.userAgent, Accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          return { ok: res.ok, status: res.status, text: await res.text().catch((err) => (res.ok ? Promise.reject(err) : '')) };
        })(),
        timeoutMs + 2_000,
        new URL(url).host,
      );
      if (ok) return text;
      const err = new HttpError(status, url, text);
      // Client errors (incl. 429 rate limits and 451 geo blocks) will not improve by retrying now.
      if (status < 500) throw err;
      lastErr = err;
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) throw err;
      lastErr = err;
    }
    if (attempt < retries) await sleep(600 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** GET a JSON document. */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  return JSON.parse(await request(url, opts)) as T;
}

/** POST a JSON body and read a JSON answer. */
export async function postJson<T>(url: string, body: unknown, opts: FetchOpts = {}): Promise<T> {
  return JSON.parse(await request(url, { ...opts, body })) as T;
}

/** GET a text document (CSV feeds). */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  return request(url, { ...opts, headers: { Accept: 'text/csv,text/plain,*/*', ...opts.headers } });
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

/** A load that takes longer than this is abandoned, so a stuck one cannot block every later caller. */
const LOAD_DEADLINE_MS = 120_000;

/** Tiny in-memory TTL cache for on-demand (non persisted) upstream calls. */
export function ttlCache<T>(ttlMs: number, load: () => Promise<T>, deadlineMs = LOAD_DEADLINE_MS): () => Promise<T> {
  let value: T | undefined;
  let at = 0;
  let pending: Promise<T> | null = null;
  return async () => {
    if (value !== undefined && Date.now() - at < ttlMs) return value;
    if (!pending) {
      pending = withDeadline(load(), deadlineMs, 'upstream data')
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

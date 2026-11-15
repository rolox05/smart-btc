/**
 * A websocket client that keeps itself connected: it reconnects with exponential backoff, sends the
 * subscriptions again after every reconnect and, where the venue asks for one, an application-level ping.
 */
export interface SocketSpec {
  url: string;
  /** Messages sent right after connecting (subscriptions). */
  hello?: unknown[];
  /** Application-level keep-alive, where the venue requires one. */
  ping?: { everyMs: number; message: unknown };
  /** Reconnect when nothing has arrived for this long: a silent socket is not always reported as closed. */
  staleAfterMs?: number;
}

export interface SocketStatus {
  connected: boolean;
  lastEventAt: number | null;
  error: string | null;
}

const MAX_BACKOFF_MS = 60_000;

export class ReconnectingSocket {
  readonly status: SocketStatus = { connected: false, lastEventAt: null, error: null };
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 1000;
  private lastFrameAt = 0;
  private stopped = true;

  constructor(
    private spec: SocketSpec,
    private onMessage: (msg: unknown) => void,
    private onOpen: () => void = () => {},
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.clearInterval();
    this.ws?.close();
    this.ws = null;
    this.status.connected = false;
  }

  private clearInterval() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private schedule() {
    if (this.stopped || this.retry) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, wait);
  }

  private connect() {
    if (this.stopped) return;
    const { spec, status } = this;
    let ws: WebSocket;
    try {
      ws = new WebSocket(spec.url);
    } catch (err) {
      status.error = (err as Error).message;
      this.schedule();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      status.connected = true;
      status.error = null;
      this.backoffMs = 1000;
      this.lastFrameAt = Date.now();
      for (const m of spec.hello ?? []) ws.send(JSON.stringify(m));
      const tickMs = Math.min(spec.ping?.everyMs ?? Infinity, spec.staleAfterMs ?? Infinity);
      if (Number.isFinite(tickMs)) {
        let sincePing = 0;
        this.interval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (spec.staleAfterMs && Date.now() - this.lastFrameAt > spec.staleAfterMs) {
            status.error = 'no data received';
            ws.close();
            return;
          }
          sincePing += tickMs;
          if (spec.ping && sincePing >= spec.ping.everyMs) {
            sincePing = 0;
            ws.send(JSON.stringify(spec.ping.message));
          }
        }, tickMs);
      }
      this.onOpen();
    });
    ws.addEventListener('message', (ev) => {
      this.lastFrameAt = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // a malformed frame is not worth dropping the connection for
      }
      this.onMessage(msg);
    });
    ws.addEventListener('error', () => {
      status.error = 'connection error';
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      status.connected = false;
      this.clearInterval();
      this.schedule();
    });
  }
}

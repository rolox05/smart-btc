import type { AlertEvent, LiveEvents } from '@smart-btc/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/** A price older than this means the stream has stalled and polling should take over. */
const TICKER_STALE_MS = 8_000;
/** How long an alert stays on screen. */
const ALERT_SHOWN_MS = 15_000;
/** Liquidations can arrive in bursts; the summary is refreshed at most this often. */
const LIQUIDATION_REFRESH_MS = 1_000;

/**
 * Listens to the server's live stream (Server-Sent Events) and feeds it into the query cache:
 * the price replaces the polled ticker, each liquidation refreshes the liquidation summary if it is
 * on screen, and an alert that fires is shown at once. Returns whether prices are arriving, so callers can stop polling while they are.
 */
export function useLiveStream(): { pushed: boolean; alert: AlertEvent | null; dismissAlert: () => void } {
  const qc = useQueryClient();
  const [pushed, setPushed] = useState(false);
  const [alert, setAlert] = useState<AlertEvent | null>(null);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/stream');
    let lastTickerAt = 0;
    let refresh: ReturnType<typeof setTimeout> | null = null;
    let hide: ReturnType<typeof setTimeout> | null = null;

    const on = <K extends keyof LiveEvents>(event: K, handle: (data: LiveEvents[K]) => void) =>
      source.addEventListener(event, (ev) => {
        try {
          handle(JSON.parse((ev as MessageEvent<string>).data) as LiveEvents[K]);
        } catch {
          /* ignore a malformed frame */
        }
      });

    on('ticker', (ticker) => {
      lastTickerAt = Date.now();
      // A hidden tab keeps the latest price without re-rendering the charts every second.
      if (document.visibilityState === 'visible' || !qc.getQueryData(['ticker'])) qc.setQueryData(['ticker'], ticker);
      setPushed(true);
    });
    on('liquidations', () => {
      refresh ??= setTimeout(() => {
        refresh = null;
        void qc.invalidateQueries({ queryKey: ['liquidations'] });
      }, LIQUIDATION_REFRESH_MS);
    });

    on('alert', (event) => {
      setAlert(event);
      if (hide) clearTimeout(hide);
      hide = setTimeout(() => setAlert(null), ALERT_SHOWN_MS);
      // The rule may have switched itself off, and the delivery log has a new line.
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    });

    // EventSource reconnects by itself; this only notices when prices stop so polling can resume.
    const watchdog = setInterval(() => setPushed(Date.now() - lastTickerAt < TICKER_STALE_MS), 4_000);
    return () => {
      source.close();
      clearInterval(watchdog);
      if (refresh) clearTimeout(refresh);
      if (hide) clearTimeout(hide);
    };
  }, [qc]);

  return { pushed, alert, dismissAlert: () => setAlert(null) };
}

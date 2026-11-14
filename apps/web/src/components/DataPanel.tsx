import type { Overview, SourceStatus } from '@smart-btc/shared';
import { CheckCircle2, CircleAlert, Clock, RefreshCw } from 'lucide-react';
import { fmtAgo, fmtDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { Card, Note } from './ui';

function StatusIcon({ s }: { s: SourceStatus }) {
  const { t } = useT();
  if (s.status === 'ok') return <CheckCircle2 size={14} className="shrink-0 text-good" aria-label={t('Live')} />;
  if (s.status === 'pending') return <Clock size={14} className="shrink-0 text-mute" aria-label={t('First sync pending')} />;
  return <CircleAlert size={14} className={`shrink-0 ${s.status === 'stale' ? 'text-warn' : 'text-crit'}`} aria-label={t(STATUS_TEXT[s.status])} />;
}

const STATUS_TEXT: Record<SourceStatus['status'], string> = {
  ok: 'Live',
  pending: 'First sync pending',
  stale: 'Using saved data',
  error: 'Unavailable',
};

export function DataPanel({ overview, onRefresh, refreshing }: { overview: Overview; onRefresh: () => void; refreshing: boolean }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <Card
        title={t('Data sources')}
        right={
          <button onClick={onRefresh} disabled={refreshing} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:bg-raised disabled:opacity-50">
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> {t('Sync now')}
          </button>
        }
      >
        <ul className="divide-y divide-line">
          {overview.sources.map((s) => (
            <li key={s.id} className="flex items-start gap-2.5 py-2">
              <span className="mt-0.5"><StatusIcon s={s} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-xs font-medium text-ink underline-offset-2 hover:underline">
                    {s.name}
                  </a>
                  <span className="num shrink-0 text-[11px] text-mute">
                    {t(STATUS_TEXT[s.status])} · {fmtAgo(s.lastOk)}
                  </span>
                </div>
                <div className="text-[11px] leading-relaxed text-mute">{s.provides}</div>
                {s.message && <div className="mt-0.5 break-words text-[11px] text-warn">{s.message}</div>}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t('All sources are free and need no API key. Everything is cached in a local SQLite file (data/smart-btc.db), so the app keeps working offline with the last synced data. Price history: {from} → {to} ({n} days).', { from: fmtDate(overview.history.from), to: fmtDate(overview.history.to), n: overview.history.days.toLocaleString('en-US') })}
        </p>
      </Card>

      <Note>
        {t('Research tool for personal use, not financial advice. Probabilities are historical frequencies of similar situations, they are uncertain and can be wrong, especially around news and regime changes.')}
      </Note>
    </div>
  );
}

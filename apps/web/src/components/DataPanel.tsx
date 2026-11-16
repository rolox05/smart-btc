import type { HealthGrade, Overview, SourceStatus } from '@smart-btc/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, CircleAlert, CircleSlash, Clock, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { fmtAgo, fmtDate } from '../lib/format';
import { msg, useT } from '../lib/i18n';
import { Badge, Card, Note, Switch } from './ui';

function StatusIcon({ s }: { s: SourceStatus }) {
  const { t } = useT();
  const label = t(STATUS_TEXT[s.status]);
  if (s.status === 'off') return <CircleSlash size={14} className="shrink-0 text-mute" aria-label={label} />;
  if (s.status === 'ok') return <CheckCircle2 size={14} className="shrink-0 text-good" aria-label={label} />;
  if (s.status === 'pending') return <Clock size={14} className="shrink-0 text-mute" aria-label={label} />;
  return <CircleAlert size={14} className={`shrink-0 ${s.status === 'stale' ? 'text-warn' : 'text-crit'}`} aria-label={label} />;
}

const STATUS_TEXT: Record<SourceStatus['status'], string> = {
  ok: msg('Live'),
  pending: msg('First sync pending'),
  stale: msg('Using saved data'),
  error: msg('Unavailable'),
  off: msg('Switched off'),
};

const GRADE: Record<HealthGrade, { text: string; tone: 'good' | 'warn' | 'crit' | 'neutral'; dot: string }> = {
  good: { text: msg('Healthy'), tone: 'good', dot: 'bg-good' },
  warn: { text: msg('Needs a look'), tone: 'warn', dot: 'bg-warn' },
  bad: { text: msg('Looks corrupt'), tone: 'crit', dot: 'bg-crit' },
  unknown: { text: msg('Not judged yet'), tone: 'neutral', dot: 'bg-mute' },
};

function SourceRow({ s, onToggle, busy }: { s: SourceStatus; onToggle: (enabled: boolean) => void; busy: boolean }) {
  const { t } = useT();
  const grade = s.health ? GRADE[s.health.grade] : null;
  const troubled = s.health?.grade === 'warn' || s.health?.grade === 'bad';
  return (
    <li className="flex items-start gap-2.5 py-2">
      <span className="mt-0.5"><StatusIcon s={s} /></span>
      <div className={clsx('min-w-0 flex-1', !s.enabled && 'opacity-60')}>
        <div className="flex items-center justify-between gap-2">
          <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-xs font-medium text-ink underline-offset-2 hover:underline">
            {s.name}
          </a>
          <span className="flex shrink-0 items-center gap-2">
            {grade && s.health && (
              <Badge tone={grade.tone} title={t('Health score, 0 to 100, from the checks below')}>
                {t(grade.text)}
                {s.health.score != null && <span className="num"> · {s.health.score}</span>}
              </Badge>
            )}
            <span className="num text-[11px] text-mute">
              {t(STATUS_TEXT[s.status])}
              {s.enabled && <> · {fmtAgo(s.lastOk)}</>}
            </span>
          </span>
        </div>
        <div className="text-[11px] leading-relaxed text-mute">{s.provides}</div>
        {s.feeds.length > 0 && (
          <div className="text-[11px] leading-relaxed text-mute">
            {t(s.enabled ? 'Feeds:' : 'Left out while off:')} <span className="text-ink2">{s.feeds.join(', ')}</span>
          </div>
        )}
        {s.enabled && s.message && <div className="mt-0.5 break-words text-[11px] text-warn">{s.message}</div>}
        {s.health && s.health.checks.length > 0 && (
          <details className="mt-1" open={troubled}>
            <summary className="cursor-pointer text-[11px] text-ink2 hover:text-ink">{t('Health checks')}</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {s.health.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-1.5 text-[11px] leading-relaxed">
                  <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', GRADE[c.grade].dot)} aria-label={t(GRADE[c.grade].text)} />
                  <span className="min-w-0 break-words text-mute">
                    <span className="text-ink2">{c.label}.</span> {c.detail}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <span className="mt-0.5">
        <Switch bare checked={s.enabled} disabled={busy} onChange={onToggle} label={t('Use {name}', { name: s.name })} />
      </span>
    </li>
  );
}

export function DataPanel({ overview, onRefresh, refreshing }: { overview: Overview; onRefresh: () => void; refreshing: boolean }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setSourceEnabled(id, enabled),
    onSuccess: (sources) => {
      // The list answers at once; every chart, reading and forecast that may have used the source is
      // then fetched again in the background (not awaited, so the switches stay usable meanwhile).
      qc.setQueriesData<Overview>({ queryKey: ['overview'] }, (old) => old && { ...old, sources });
      void qc.invalidateQueries();
    },
  });
  const sources = overview.sources;
  const count = (g: HealthGrade) => sources.filter((s) => s.health?.grade === g).length;
  const off = sources.filter((s) => !s.enabled).length;
  const corrupt = sources.filter((s) => s.health?.grade === 'bad');
  const summary = [
    t('{n} healthy', { n: count('good') }),
    count('warn') > 0 && t('{n} need a look', { n: count('warn') }),
    corrupt.length > 0 && t('{n} look corrupt', { n: corrupt.length }),
    off > 0 && t('{n} switched off', { n: off }),
  ].filter(Boolean);

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
        <p className="text-[11px] leading-relaxed text-mute">
          <span className="num text-ink2">{summary.join(' · ')}.</span>{' '}
          {t('Each source is checked for failed downloads, late or missing values, impossible or stuck values, and disagreement with other sources. Switch a source off to stop downloading it and leave its data out of every chart and model; what it already stored is kept.')}
        </p>
        {corrupt.length > 0 && (
          <div className="mt-2">
            <Note tone="warn">{t('{names} failed its checks. Look at the details below and consider switching it off until it recovers.', { names: corrupt.map((s) => s.name).join(', ') })}</Note>
          </div>
        )}
        {toggle.error && (
          <div className="mt-2">
            <Note tone="error">{toggle.error.message}</Note>
          </div>
        )}
        <ul className="mt-2 divide-y divide-line">
          {sources.map((s) => (
            <SourceRow key={s.id} s={s} busy={toggle.isPending} onToggle={(enabled) => toggle.mutate({ id: s.id, enabled })} />
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

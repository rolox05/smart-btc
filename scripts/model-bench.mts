/**
 * Walk-forward comparison of forecast-model variants on the local data store.
 *
 *   npx tsx scripts/model-bench.mts
 *
 * Every variant runs the same backtest the app uses (past-only features, analogs that finished
 * before the evaluated bar), so the numbers are directly comparable. Keep in mind that choosing the
 * best variant on this history is itself a mild form of fitting: only adopt consistent winners.
 */
import { DEFAULT_FORECAST_SETTINGS, type ForecastSettings } from '../packages/shared/src/index.js';
import { DatasetService } from '../apps/server/src/analytics/dataset.js';
import { config } from '../apps/server/src/config.js';
import { prepare } from '../apps/server/src/forecast/analog.js';
import { runBacktest } from '../apps/server/src/forecast/backtest.js';
import { openSqliteStore } from '../apps/server/src/store/sqliteStore.js';

const store = openSqliteStore(config.dataDir);
const ds = (await new DatasetService(store).get('1d'))!;

const FEATURE_SETS: Record<string, string[]> = {
  default: ['rsi14', 'vol30', 'ddDays10', 'ddDays20', 'cycleDay'],
  broad: ['rsi14', 'vol30', 'mom30', 'ddDays10', 'ddDays20', 'cycleDay', 'mvrv', 'fng'],
};
const VARIANTS: Record<string, Partial<ForecastSettings>> = Object.fromEntries(
  (process.env.VARIANTS ?? '')
    .split(';')
    .filter(Boolean)
    .map((v) => {
      const [name, json] = v.split('=');
      return [name, JSON.parse(json)];
    }),
);
if (!Object.keys(VARIANTS).length) {
  Object.assign(VARIANTS, {
    current: {},
    mahal: { distance: 'mahalanobis' },
    gap25: { analogGapFraction: 0.25 },
    gap50: { analogGapFraction: 0.5 },
    median: { kernel: 'median' },
    adapt10: { blendMode: 'adaptive', blendKappa: 10 },
    adapt20: { blendMode: 'adaptive', blendKappa: 20 },
    k30: { k: 30 },
    k120: { k: 120 },
  });
}
const horizons = (process.env.H ?? '7,30,90').split(',').map(Number);

const preps = new Map(horizons.map((H) => [H, prepare(ds, H)]));
const rows: string[] = [];
for (const [fs, features] of Object.entries(FEATURE_SETS)) {
  for (const H of horizons) {
    for (const [name, v] of Object.entries(VARIANTS)) {
      const settings: ForecastSettings = { ...DEFAULT_FORECAST_SETTINGS, horizon: H, features, ...v };
      const r = runBacktest(ds, preps.get(H)!, { settings, stepBars: Math.max(1, Math.round(H / 6)), touchPct: 0 });
      const avg = r.scores.reduce((a, s) => a + s.skill, 0) / r.scores.length;
      const cov = r.coverage.map((c) => `${Math.round(c.observed * 100)}/${Math.round(c.nominal * 100)}`).join(' ');
      const cells = r.scores.map((s) => `${s.event}:${(s.skill * 100).toFixed(1)}`).join(' ');
      rows.push(`${fs.padEnd(8)} H=${String(H).padEnd(3)} ${name.padEnd(9)} avg=${(avg * 100).toFixed(2).padStart(6)}%  ${cells}  cov ${cov}  mae ${r.medianError.model.toFixed(2)}  n=${r.evaluations}`);
      console.log(rows[rows.length - 1]);
    }
  }
}

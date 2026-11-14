import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradeOutcome } from '@smart-btc/shared';
import { prepare } from '../src/forecast/analog.js';
import { kellySizing, riskStats, runTradeSetup, simulate } from '../src/forecast/tradeSetup.js';
import { settings, syntheticDataset } from './synthetic.js';

const outcome = (o: Partial<TradeOutcome>): TradeOutcome => ({
  pTake: 0,
  pStop: 0,
  pTimeout: 0,
  avgTimeoutPct: 0,
  daysToTake: null,
  daysToStop: null,
  evPct: 0,
  evR: 0,
  ...o,
});

test('kelly: a fair coin paying 2:1 sizes at the textbook 25%', () => {
  // p = 0.5, b = 2  →  f* = p − q / b = 0.25. No costs: evR equals evPct / stop.
  const o = outcome({ pTake: 0.5, pStop: 0.5, evPct: 0.5 * 10 - 0.5 * 5, evR: (0.5 * 10 - 0.5 * 5) / 5 });
  const k = kellySizing(o, 5, 10, 0.5);
  assert.ok(Math.abs(k.fullRiskPct - 25) < 0.2, `full Kelly ${k.fullRiskPct}`);
  assert.ok(Math.abs(k.suggestedRiskPct - k.fullRiskPct * 0.5) < 1e-9);
});

test('kelly: a bet without an edge gets no size', () => {
  const o = outcome({ pTake: 0.3, pStop: 0.7, evPct: 0.3 * 10 - 0.7 * 5, evR: (0.3 * 10 - 0.7 * 5) / 5 });
  assert.equal(kellySizing(o, 5, 10, 1).fullRiskPct, 0);
});

test('bracket replay: probabilities cover every path exactly once', () => {
  const ds = syntheticDataset();
  const prep = prepare(ds, 30);
  const idx = Array.from({ length: 200 }, (_, j) => 300 + j * 5);
  const sample = { idx, w: new Float64Array(idx.length).fill(1 / idx.length), scale: idx.map(() => 1) };
  const o = simulate(prep, sample, 'long', 5, 10, { feePct: 0, fundingPctPerBar: 0 });
  assert.ok(Math.abs(o.pTake + o.pStop + o.pTimeout - 1) < 1e-9);
  // A wider stop can only be hit less often.
  const wide = simulate(prep, sample, 'long', 15, 10, { feePct: 0, fundingPctPerBar: 0 });
  assert.ok(wide.pStop <= o.pStop);
});

test('tail risk: Expected Shortfall is at least as bad as VaR, and tighter confidence is worse', () => {
  const ds = syntheticDataset();
  const prep = prepare(ds, 30);
  const idx = Array.from({ length: 200 }, (_, j) => 300 + j * 5);
  const sample = { idx, w: new Float64Array(idx.length).fill(1 / idx.length), scale: idx.map(() => 1) };
  const r95 = riskStats(prep, sample, 'long', 0.95, 5, 10_000);
  const r99 = riskStats(prep, sample, 'long', 0.99, 5, 10_000);
  assert.ok(r95.esPct >= r95.varPct);
  assert.ok(r99.varPct >= r95.varPct);
  assert.ok(r95.pBeyondStop >= 0 && r95.pBeyondStop <= 1);
});

test('trade setup: ATR and R modes resolve to the distances they describe', () => {
  const ds = syntheticDataset();
  const s = settings({ horizon: 30 });
  const r = runTradeSetup(ds, prepare(ds, 30), {
    settings: s,
    side: 'long',
    entry: 0,
    stopPct: 5,
    takePct: 10,
    leverage: 2,
    accountUsd: 10_000,
    riskPct: 1,
    feeBps: 5,
    stopMode: 'atr',
    stopAtr: 2,
    takeMode: 'r',
    takeR: 3,
  });
  assert.ok(Math.abs(r.stopPct - 2 * r.atrPct) < 1e-9);
  assert.ok(Math.abs(r.takePct - 3 * r.stopPct) < 1e-9);
  assert.ok(Math.abs(r.rewardRisk - 3) < 1e-9);
  // Sizing: hitting the stop loses exactly the chosen share of the account.
  assert.ok(Math.abs(r.positionNotionalUsd * (r.stopPct / 100) - 100) < 1e-6);
});

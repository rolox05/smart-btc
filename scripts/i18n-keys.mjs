#!/usr/bin/env node
/**
 * Lists the English source strings that need a translation, and reports the ones missing from the
 * Spanish and Portuguese dictionaries.
 *
 *   node scripts/i18n-keys.mjs            # report missing keys (exit code 1 if any)
 *   node scripts/i18n-keys.mjs --list     # print every key as JSON
 *
 * Keys are found statically: every string literal inside a call to t( / tr( / tx( (and the reading
 * helper r( on the server), plus a few catalogues whose values are translated through a variable.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGETS = {
  web: { dirs: ['apps/web/src'], dicts: ['apps/web/src/locales/es.ts', 'apps/web/src/locales/pt.ts'], skip: ['locales'] },
  server: { dirs: ['apps/server/src', 'packages/shared/src'], dicts: ['apps/server/src/i18n/es.ts', 'apps/server/src/i18n/pt.ts'], skip: ['i18n', 'guide.ts'] },
};

/** Values of these object keys are display text translated through a variable. */
const LABEL_FIELDS = {
  web: ['label', 'hint'],
  server: ['source', 'provides'],
};
/**
 * Literals the scanner picks up that are not display text (code tokens, CSS classes, locale codes)
 * or that stay the same in every language (data-source brand names).
 */
const IGNORE = new Set([
  ', ', '; ', 'en-US', 'numeric', 'buy-side', 'rally', 'bullish', 'bearish', 'neutral', 'num text-ink', 'num text-ink2',
  'cone', 'swings', 'targets', 'walls', 'liquidations',
  'Binance', 'BGeometrics', 'Coin Metrics', 'DefiLlama', 'Deribit', 'alternative.me', 'Bybit', 'Hyperliquid', 'Yahoo Finance', 'CFTC',
]);
/** Short identifiers that are real keys even though they look like code. */
const KEEP_SHORT = new Set(['long', 'short', 'good', 'low', 'moderate', 'All', 'R']);

function walk(dir, skip, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip.some((s) => p.includes(`/${s}`))) continue;
    if (statSync(p).isDirectory()) walk(p, skip, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Read a quoted literal starting at i (s[i] is the quote). Returns [value, endIndex]. */
function readString(s, i) {
  const q = s[i];
  let v = '';
  let j = i + 1;
  while (j < s.length && s[j] !== q) {
    if (s[j] === '\\') {
      const n = s[j + 1];
      v += n === 'n' ? '\n' : n;
      j += 2;
    } else v += s[j++];
  }
  return [v, j];
}

function skipTemplate(s, i) {
  let j = i + 1;
  while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
  return j;
}

/** All plain string literals inside the argument list of each call to one of `fns`. */
function callLiterals(src, fns) {
  const keys = [];
  const re = new RegExp(`(?<![\\w.])(${fns.join('|')})\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "'" || c === '"') {
        const [v, end] = readString(src, i);
        keys.push(v);
        i = end + 1;
        continue;
      }
      if (c === '`') {
        i = skipTemplate(src, i) + 1;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
  }
  return keys;
}

function fieldLiterals(src, fields) {
  const keys = [];
  const re = new RegExp(`\\b(?:${fields.join('|')}):\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`, 'g');
  let m;
  while ((m = re.exec(src))) keys.push(m[2].replace(/\\(.)/g, '$1'));
  return keys;
}

function collect(target) {
  const cfg = TARGETS[target];
  const keys = new Set();
  for (const dir of cfg.dirs) {
    for (const file of walk(join(ROOT, dir), cfg.skip)) {
      const src = readFileSync(file, 'utf8');
      const fns = target === 'server' ? ['t', 'tr', 'r'] : ['t', 'tr', 'tx', 'layer', 'msg'];
      for (const k of [...callLiterals(src, fns), ...fieldLiterals(src, LABEL_FIELDS[target])]) keys.add(k);
      if (target === 'web' && file.endsWith('GuidePanel.tsx')) {
        // TERMS and WINDOW_LABEL tables
        for (const m of src.matchAll(/\['([^']+)',\s*(["'])((?:\\.|(?!\2).)*)\2\]/g)) {
          keys.add(m[1]);
          keys.add(m[3].replace(/\\(.)/g, '$1'));
        }
        for (const m of src.matchAll(/(?:all|'4y'|'1y'): '([^']+)'/g)) keys.add(m[1]);
      }
      if (target === 'web' && /DataPanel|LiquidityPanel/.test(file)) {
        for (const m of src.matchAll(/(?:ok|pending|stale|error|swing|liquidation|orderbook): '([^']+)'/g)) keys.add(m[1]);
      }
      if (target === 'server' && file.endsWith('divergence.ts')) {
        for (const m of src.matchAll(/(?:name|description):\s*\n?\s*'([^']+)'/g)) keys.add(m[1]);
      }
      if (target === 'server' && file.endsWith('metrics.ts')) {
        for (const m of src.matchAll(/\{ value: [\d.]+, label: '([^']*)' \}/g)) keys.add(m[1]);
      }
    }
  }
  if (target === 'web') {
    const shared = readFileSync(join(ROOT, 'packages/shared/src/index.ts'), 'utf8');
    const block = shared.slice(shared.indexOf('METRIC_GROUP_LABEL'), shared.indexOf('};', shared.indexOf('METRIC_GROUP_LABEL')));
    for (const m of block.matchAll(/: '([^']+)'/g)) keys.add(m[1]);
    for (const k of ['measurable edge', 'weak edge', 'no edge', 'good', 'moderate', 'low', 'long', 'short']) keys.add(k);
  }
  // 'bullish' is display text in the web app (chart legend) but a tone code on the server.
  const ignored = (k) => IGNORE.has(k) && !(target === 'web' && k === 'bullish');
  return [...keys].filter((k) => !ignored(k) && k.trim() && (/[\s.…:?!]/.test(k) || /^[A-Z]/.test(k) || KEEP_SHORT.has(k) || k.length > 3) && !/^[a-z]+[A-Z]\w*$/.test(k) && !/^(sma|bb|rsi|mom|vol|dd|sth|cm\.|bg\.|binance|deribit|llama|fng)/.test(k)).sort();
}

async function main() {
  const list = process.argv.includes('--list');
  let missingTotal = 0;
  const out = {};
  for (const target of Object.keys(TARGETS)) {
    const keys = collect(target);
    out[target] = keys;
    if (list) continue;
    for (const dictPath of TARGETS[target].dicts) {
      const src = readFileSync(join(ROOT, dictPath), 'utf8');
      const missing = keys.filter((k) => !src.includes(JSON.stringify(k)) && !src.includes(`'${k.replace(/'/g, "\\'")}'`));
      missingTotal += missing.length;
      console.log(`${relative(ROOT, join(ROOT, dictPath))}: ${keys.length - missing.length}/${keys.length} keys translated`);
      for (const k of missing.slice(0, 40)) console.log(`  missing: ${k}`);
      if (missing.length > 40) console.log(`  … and ${missing.length - 40} more`);
    }
  }
  if (list) console.log(JSON.stringify(out, null, 2));
  process.exitCode = missingTotal ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

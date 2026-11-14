import { durationLabel, pickLang, translate, type Dict, type Lang, type Timeframe, type Vars } from '@smart-btc/shared';
import es from './es.js';
import pt from './pt.js';

const DICTS: Record<Lang, Dict | undefined> = { en: undefined, es, pt };

/** Translator bound to one language. Keys are the English texts, with {placeholders}. */
export interface T {
  (key: string, vars?: Vars): string;
  lang: Lang;
  /** Number of bars on a timeframe as a short duration in this language ("4h", "8sem"). */
  dur: (tf: Timeframe, bars: number) => string;
}

export function makeT(lang: Lang): T {
  const dict = DICTS[lang];
  const t = ((key: string, vars?: Vars) => translate(dict, key, vars)) as T;
  t.lang = lang;
  t.dur = (tf, bars) => durationLabel(tf, bars, lang);
  return t;
}

export const EN = makeT('en');

/** Language of a request: the client's x-lang header, then ?lang=, then Accept-Language. */
export function langOf(req: { headers: Record<string, string | string[] | undefined>; query?: unknown }): Lang {
  const header = req.headers['x-lang'];
  const query = (req.query as { lang?: string } | undefined)?.lang;
  const accept = req.headers['accept-language'];
  return pickLang([header, query, accept].flat().filter(Boolean).join(','));
}

export { DICTS };

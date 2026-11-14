import { durationLabel, translate, type Dict, type Lang, type Timeframe, type Vars } from '@smart-btc/shared';
import { Fragment, createContext, useContext, type ReactNode } from 'react';
import es from '../locales/es';
import pt from '../locales/pt';

const DICTS: Record<Lang, Dict | undefined> = { en: undefined, es, pt };
/** Locale used for dates and other locale-aware formatting. */
export const LOCALE: Record<Lang, string> = { en: 'en-GB', es: 'es-ES', pt: 'pt-BR' };

/**
 * The active language, also kept outside React so that plain helpers (formatters, the API client,
 * query keys) follow it. App sets it on every render before any child reads it.
 */
let current: Lang = 'en';
export const getLang = () => current;
export function setLang(lang: Lang) {
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/** Translate outside components (formatters). Keys are the English texts, with {placeholders}. */
export const tr = (key: string, vars?: Vars) => translate(DICTS[current], key, vars);

const LangContext = createContext<Lang>('en');
export const LangProvider = LangContext.Provider;

export interface Translator {
  lang: Lang;
  /** Translated string. */
  t: (key: string, vars?: Vars) => string;
  /** Translated text whose placeholders may be React nodes (e.g. a highlighted number). */
  tx: (key: string, vars: Record<string, ReactNode>) => ReactNode;
  /** Number of bars as a short duration in this language ("4h", "8sem"). */
  dur: (tf: Timeframe, bars: number) => string;
}

export function useT(): Translator {
  const lang = useContext(LangContext);
  const dict = DICTS[lang];
  return {
    lang,
    t: (key, vars) => translate(dict, key, vars),
    tx: (key, vars) => {
      const parts = (dict?.[key] ?? key).split(/(\{\w+\})/g);
      return parts.map((p, i) => {
        const m = /^\{(\w+)\}$/.exec(p);
        return <Fragment key={i}>{m && m[1] in vars ? vars[m[1]] : p}</Fragment>;
      });
    },
    dur: (tf, bars) => durationLabel(tf, bars, lang),
  };
}

export { DICTS };

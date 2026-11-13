/** Categorical series colours, dark-surface steps, in their validated fixed order. */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export const UI = {
  bg: '#111110',
  panel: '#1a1a19',
  raised: '#242422',
  line: '#2f2f2c',
  grid: '#232321',
  ink: '#f0efec',
  ink2: '#c3c2b7',
  mute: '#8b8a80',
  accent: '#3987e5',
  up: '#1fa97a',
  down: '#e25c5c',
  good: '#0ca30c',
  warn: '#fab219',
  crit: '#d03b3b',
};

/** Diverging blue ↔ red with a neutral grey midpoint, for signed values (e.g. expected value). */
export function diverging(x: number, max: number): string {
  const t = Math.max(-1, Math.min(1, x / max));
  const mid = [56, 56, 53];
  const pole = t >= 0 ? [57, 135, 229] : [230, 103, 103];
  const a = Math.abs(t);
  const c = mid.map((m, i) => Math.round(m + (pole[i] - m) * a));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

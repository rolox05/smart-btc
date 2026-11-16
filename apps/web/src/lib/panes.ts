import type { MetricDef } from '@smart-btc/shared';

/** One indicator chart under the price chart: the metrics that share its axis. */
export interface ChartPane {
  id: string;
  metrics: MetricDef[];
  /** Switched off as a whole; its metrics stay selected so it comes back as it was. */
  hidden: boolean;
}

/**
 * The indicator charts for the metrics switched on, in the user's order. Charts the user has never
 * moved keep the catalogue order and come after the ones that were placed by hand.
 */
export function chartPanes(metrics: MetricDef[], visible: string[], order: string[], hidden: string[]): ChartPane[] {
  const panes: ChartPane[] = [];
  for (const m of metrics) {
    if (m.display !== 'pane' || !visible.includes(m.id)) continue;
    const id = m.pane ?? m.id;
    const pane = panes.find((p) => p.id === id);
    if (pane) pane.metrics.push(m);
    else panes.push({ id, metrics: [m], hidden: hidden.includes(id) });
  }
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Infinity : i;
  };
  // Array.sort is stable, so charts without a saved position keep their catalogue order.
  return panes.sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * The order after moving one chart a step up (-1) or down (+1). `amongShown` steps over charts that
 * are switched off, which is what "up" means when looking at the chart itself.
 */
export function movePane(panes: ChartPane[], id: string, dir: -1 | 1, amongShown: boolean): string[] {
  const ids = panes.map((p) => p.id);
  const from = ids.indexOf(id);
  let to = from + dir;
  while (amongShown && panes[to]?.hidden) to += dir;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}

/** The order after dropping one chart just before or just after another. */
export function placePane(panes: ChartPane[], id: string, targetId: string, after: boolean): string[] {
  const ids = panes.map((p) => p.id);
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return ids;
  const rest = ids.filter((x) => x !== id);
  rest.splice(rest.indexOf(targetId) + (after ? 1 : 0), 0, id);
  return rest;
}

export const paneName = (p: ChartPane) => p.metrics.map((m) => m.short).join(' · ');

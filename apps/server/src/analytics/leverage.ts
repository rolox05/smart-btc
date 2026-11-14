/**
 * Maintenance margin assumed wherever a liquidation price is estimated (isolated margin, lowest tier on
 * the large perpetual venues). One definition, so the trade planner, the liquidity report and the
 * liquidation heatmap always agree on where a position at a given leverage is force-closed.
 */
export const MAINT_MARGIN = 0.005;

/** Liquidation price of a position entered at `entry` with `leverage`: below entry for longs, above for shorts. */
export function liquidationPrice(entry: number, leverage: number, side: 'long' | 'short'): number {
  const dir = side === 'long' ? 1 : -1;
  return entry * (1 - dir * (1 / leverage - MAINT_MARGIN));
}

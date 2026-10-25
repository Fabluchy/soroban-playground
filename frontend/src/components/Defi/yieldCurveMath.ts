/** Constant-product pool math used by the Soroban AMM (x*y=k). */
export function impermanentLoss(priceRatio: number): number {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return 0;
  return (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
}

/** Fraction of a concentrated position's liquidity held as token A. */
export function concentratedAmounts(
  price: number,
  lower: number,
  upper: number,
): { tokenA: number; tokenB: number } {
  const lo = Math.sqrt(Math.max(lower, Number.EPSILON));
  const hi = Math.sqrt(Math.max(upper, lower + Number.EPSILON));
  const p = Math.sqrt(Math.max(price, Number.EPSILON));
  if (p <= lo) return { tokenA: 1 / lo - 1 / hi, tokenB: 0 };
  if (p >= hi) return { tokenA: 0, tokenB: hi - lo };
  return { tokenA: 1 / p - 1 / hi, tokenB: p - lo };
}

/** Concentrated position value relative to holding its initial token mix. */
export function concentratedRelativeValue(
  priceRatio: number,
  lower: number,
  upper: number,
): number {
  const initial = concentratedAmounts(1, lower, upper);
  const current = concentratedAmounts(priceRatio, lower, upper);
  const initialValue = initial.tokenA + initial.tokenB;
  const hodlValue = initial.tokenA * priceRatio + initial.tokenB;
  return initialValue > 0 ? (current.tokenA * priceRatio + current.tokenB) / hodlValue - 1 : 0;
}

export function estimatedFeeApr(
  dailyVolume: number,
  feeBps: number,
  liquiditySharePct: number,
  positionValue: number,
): number {
  if (positionValue <= 0) return 0;
  return (dailyVolume * (feeBps / 10_000) * (liquiditySharePct / 100) * 365) / positionValue;
}

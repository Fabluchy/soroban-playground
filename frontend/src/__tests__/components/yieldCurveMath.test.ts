import {
  concentratedAmounts,
  concentratedRelativeValue,
  estimatedFeeApr,
  impermanentLoss,
} from "../../components/Defi/yieldCurveMath";

describe("Soroban AMM yield math", () => {
  test("constant-product impermanent loss is zero at entry and symmetric in reciprocal price", () => {
    expect(impermanentLoss(1)).toBe(0);
    expect(impermanentLoss(4)).toBeCloseTo(-0.2, 10);
    expect(impermanentLoss(0.25)).toBeCloseTo(-0.2, 10);
  });

  test("concentrated liquidity holds only token A below its range and token B above", () => {
    expect(concentratedAmounts(0.25, 0.5, 2).tokenB).toBe(0);
    expect(concentratedAmounts(4, 0.5, 2).tokenA).toBe(0);
  });

  test("concentrated position has no relative loss at entry", () => {
    expect(concentratedRelativeValue(1, 0.5, 2)).toBeCloseTo(0, 10);
  });

  test("annualizes the fee share from daily volume and configured bps", () => {
    expect(estimatedFeeApr(1_000_000, 30, 1, 10_000)).toBeCloseTo(1.095, 10);
    expect(estimatedFeeApr(1_000_000, 30, 1, 0)).toBe(0);
  });
});

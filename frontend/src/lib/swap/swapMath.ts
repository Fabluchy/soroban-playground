// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file swapMath.ts
 * Pure mathematical routing engine, constant-product AMM simulator,
 * and MEV / Sandwich Attack vulnerability detector.
 */

import type {
  LiquidityPool,
  SwapHop,
  SwapRoute,
  MevAnalysis,
  MevRiskLevel,
  ProtectiveSuggestions,
  SimulationResult,
} from './types';

/**
 * Calculate output tokens from a single constant-product AMM hop (x * y = k)
 * with basis point fee deduction.
 *
 * @param amountIn Amount of input token in base units (stroops)
 * @param reserveIn Pool reserve of input token
 * @param reserveOut Pool reserve of output token
 * @param feeBps Pool fee in basis points (e.g. 30 = 0.3%)
 * @returns Floored output token amount
 */
export function calculateHopAmountOut(
  amountIn: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number
): number {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0 ||
      ![amountIn, reserveIn, reserveOut].every(Number.isSafeInteger) ||
      !Number.isFinite(feeBps)) {
    return 0;
  }

  // Ensure feeBps is bounded in [0, 10000]
  const clampedFee = Math.trunc(Math.min(10_000, Math.max(0, feeBps)));
  const feeMultiplier = 10_000 - clampedFee;
  const inputWithFee = BigInt(amountIn) * BigInt(feeMultiplier);
  const numerator = inputWithFee * BigInt(reserveOut);
  const denominator = BigInt(reserveIn) * 10_000n + inputWithFee;
  const output = numerator / denominator;
  // Public APIs and UI use number amounts, so reject values that cannot be
  // represented exactly instead of silently returning a rounded result.
  return output <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(output) : 0;
}

/**
 * Calculate the spot price of a single hop before trade execution.
 */
export function calculateHopSpotPrice(reserveIn: number, reserveOut: number): number {
  if (reserveIn <= 0) return 0;
  return reserveOut / reserveIn;
}

/**
 * Calculate compounded price impact across a multi-hop execution path.
 */
export function calculatePriceImpact(
  initialAmountIn: number,
  finalAmountOut: number,
  hops: SwapHop[]
): number {
  if (initialAmountIn <= 0 || finalAmountOut <= 0 || hops.length === 0) {
    return 0;
  }

  // Calculate cumulative spot price before any trade occurs
  let cumulativeSpotPrice = 1.0;
  for (const hop of hops) {
    const spot = calculateHopSpotPrice(hop.reserveIn, hop.reserveOut);
    if (spot <= 0) return 0;
    cumulativeSpotPrice *= spot;
  }

  if (cumulativeSpotPrice <= 0) return 0;

  const effectiveExecutionPrice = finalAmountOut / initialAmountIn;
  const impact = ((cumulativeSpotPrice - effectiveExecutionPrice) / cumulativeSpotPrice) * 100;

  // Clamp price impact between 0% and 99.99%
  return Math.max(0, Math.min(99.99, parseFloat(impact.toFixed(4))));
}

/**
 * Calculate guaranteed minimum tokens received after slippage tolerance.
 *
 * @param amountOut Expected output amount
 * @param slippageTolerancePct User slippage tolerance in percent (e.g. 0.5 for 0.5%)
 */
export function calculateMinReceived(amountOut: number, slippageTolerancePct: number): number {
  if (amountOut <= 0 || !Number.isSafeInteger(amountOut) || !Number.isFinite(slippageTolerancePct)) return 0;
  const clampedSlippage = Math.max(0, Math.min(100, slippageTolerancePct));
  // Preserve six decimal places in percentage configuration while keeping the
  // token amount calculation integral.
  const slippageMillionths = BigInt(Math.round(clampedSlippage * 1_000_000));
  const retainedMillionths = 100_000_000n - slippageMillionths;
  return Number((BigInt(amountOut) * retainedMillionths) / 100_000_000n);
}

/**
 * Graph search: find all valid multi-hop swap routes up to maxHops between tokenIn and tokenOut.
 */
export function findBestSwapRoutes(
  tokenIn: string,
  tokenOut: string,
  amountIn: number,
  pools: LiquidityPool[],
  maxHops: number = 3
): SwapRoute[] {
  if (!tokenIn || !tokenOut || tokenIn === tokenOut || amountIn <= 0 || !pools || pools.length === 0) {
    return [];
  }

  const activePools = pools.filter((p) => p.isActive && p.reserveA > 0 && p.reserveB > 0);
  const foundRoutes: SwapRoute[] = [];

  // Helper DFS path traversal
  function searchPaths(
    currentToken: string,
    targetToken: string,
    currentAmount: number,
    visitedTokens: Set<string>,
    currentHops: SwapHop[]
  ) {
    if (currentHops.length >= maxHops) return;

    for (const pool of activePools) {
      const isTokenA = pool.tokenA === currentToken;
      const isTokenB = pool.tokenB === currentToken;

      if (!isTokenA && !isTokenB) continue;

      const nextToken = isTokenA ? pool.tokenB : pool.tokenA;
      if (visitedTokens.has(nextToken)) continue;

      const reserveIn = isTokenA ? pool.reserveA : pool.reserveB;
      const reserveOut = isTokenA ? pool.reserveB : pool.reserveA;

      const hopAmountOut = calculateHopAmountOut(currentAmount, reserveIn, reserveOut, pool.feeBps);
      if (hopAmountOut <= 0) continue;

      const hopSpotPrice = calculateHopSpotPrice(reserveIn, reserveOut);
      const hopExecPrice = hopAmountOut / currentAmount;
      const hopImpact =
        hopSpotPrice > 0
          ? Math.max(0, Math.min(99.99, ((hopSpotPrice - hopExecPrice) / hopSpotPrice) * 100))
          : 0;

      const hop: SwapHop = {
        pool,
        tokenIn: currentToken,
        tokenOut: nextToken,
        reserveIn,
        reserveOut,
        feeBps: pool.feeBps,
        amountIn: currentAmount,
        amountOut: hopAmountOut,
        hopPriceImpactPct: parseFloat(hopImpact.toFixed(2)),
      };

      const nextHops = [...currentHops, hop];

      if (nextToken === targetToken) {
        // Complete path found
        const pathTokens = [tokenIn, ...nextHops.map((h) => h.tokenOut)];
        const finalAmountOut = hopAmountOut;
        const totalFeeBps = nextHops.reduce((sum, h) => sum + h.feeBps, 0);
        const priceImpactPct = calculatePriceImpact(amountIn, finalAmountOut, nextHops);
        const executionPrice = finalAmountOut / amountIn;

        foundRoutes.push({
          id: `route-${pathTokens.join('-')}-${totalFeeBps}`,
          pathTokens,
          hops: nextHops,
          initialAmountIn: amountIn,
          finalAmountOut,
          totalFeeBps,
          priceImpactPct,
          executionPrice,
        });
      } else {
        // Continue search to next hop
        const nextVisited = new Set(visitedTokens);
        nextVisited.add(nextToken);
        searchPaths(nextToken, targetToken, hopAmountOut, nextVisited, nextHops);
      }
    }
  }

  const initialVisited = new Set<string>([tokenIn]);
  searchPaths(tokenIn, tokenOut, amountIn, initialVisited, []);

  // Sort routes by highest final output tokens descending
  foundRoutes.sort((a, b) => b.finalAmountOut - a.finalAmountOut);

  if (foundRoutes.length > 0) {
    foundRoutes[0].isBestRoute = true;
  }

  return foundRoutes;
}

/**
 * Analyze sandwich attack and MEV front-running vulnerability for a simulated swap.
 */
export function analyzeMevVulnerability(
  amountIn: number,
  expectedOutput: number,
  minReceived: number,
  priceImpactPct: number,
  slippageTolerancePct: number,
  route?: SwapRoute
): MevAnalysis {
  const maxExtractableValue = Math.max(0, expectedOutput - minReceived);
  const lossPercentage = expectedOutput > 0 ? (maxExtractableValue / expectedOutput) * 100 : 0;
  const vulnerabilityReasons: string[] = [];

  let riskLevel: MevRiskLevel = 'LOW';
  let isSandwichVulnerable = false;

  // Criteria 1: Excessive user slippage tolerance (> 2.0%)
  if (slippageTolerancePct > 2.0) {
    isSandwichVulnerable = true;
    riskLevel = 'CRITICAL';
    vulnerabilityReasons.push(
      `Slippage tolerance is set excessively high (${slippageTolerancePct.toFixed(
        1
      )}% > 2.0%), leaving substantial profit margin for sandwich bots to front-run.`
    );
  } else if (slippageTolerancePct > 0.5) {
    riskLevel = 'MEDIUM';
    vulnerabilityReasons.push(
      `Slippage tolerance of ${slippageTolerancePct.toFixed(
        1
      )}% allows minor front-running arbitrage during pool volatility.`
    );
  }

  // Criteria 2: High price impact (> 3.0%)
  if (priceImpactPct > 3.0) {
    isSandwichVulnerable = true;
    riskLevel = 'CRITICAL';
    vulnerabilityReasons.push(
      `Price impact is high (${priceImpactPct.toFixed(
        2
      )}% > 3.0%), significantly altering pool reserves and attracting MEV searchers.`
    );
  } else if (priceImpactPct > 1.0 && riskLevel !== 'CRITICAL') {
    riskLevel = 'MEDIUM';
    vulnerabilityReasons.push(
      `Price impact of ${priceImpactPct.toFixed(2)}% may experience noticeable slippage.`
    );
  }

  // Criteria 3: Large trade volume relative to pool reserves (> 5% of any hop)
  if (route && route.hops) {
    for (const hop of route.hops) {
      const volumeRatio = (hop.amountIn / hop.reserveIn) * 100;
      if (volumeRatio > 5.0) {
        isSandwichVulnerable = true;
        riskLevel = 'CRITICAL';
        vulnerabilityReasons.push(
          `Trade utilizes ${volumeRatio.toFixed(1)}% of pool ${hop.pool.name}'s reserves, exposing order to liquidity depletion.`
        );
        break;
      }
    }
  }

  return {
    riskLevel,
    isSandwichVulnerable,
    slippageTolerancePct,
    priceImpactPct,
    expectedOutput,
    minReceived,
    maxExtractableValue,
    lossPercentage: parseFloat(lossPercentage.toFixed(2)),
    vulnerabilityReasons,
  };
}

/**
 * Generate actionable protective parameter suggestions.
 */
export function getProtectiveSuggestions(
  mevAnalysis: MevAnalysis,
  priceImpactPct: number,
  slippageTolerancePct: number
): ProtectiveSuggestions {
  // Recommend dynamic safe slippage: 0.1% - 0.5%
  const recommendedSlippagePct =
    priceImpactPct > 2.0 ? 0.5 : Math.max(0.1, Math.min(0.5, parseFloat((priceImpactPct * 0.25).toFixed(2))));

  // Recommended gas fee: priority bump (500 - 1000 stroops) when vulnerable
  const recommendedGasFeeStroops = mevAnalysis.isSandwichVulnerable ? 1000 : 100;

  // Suggest private routing if sandwich vulnerable
  const enablePrivateMempool = mevAnalysis.isSandwichVulnerable;

  // Suggest splitting trade if price impact is excessively large
  const splitTradeSuggested = priceImpactPct > 3.0;
  const recommendedTranches = splitTradeSuggested ? Math.min(5, Math.ceil(priceImpactPct / 2)) : undefined;

  let rationale = 'Current slippage and price impact are well within safe bounds. Standard routing recommended.';
  if (mevAnalysis.riskLevel === 'CRITICAL') {
    rationale =
      'High sandwich attack threat detected! Recommend reducing slippage to 0.5%, bumping network fee to 1000 stroops, and routing privately.';
  } else if (mevAnalysis.riskLevel === 'MEDIUM') {
    rationale =
      'Moderate MEV exposure. Tightening slippage below 0.5% will minimize potential front-running extraction.';
  }

  return {
    recommendedSlippagePct,
    recommendedGasFeeStroops,
    enablePrivateMempool,
    splitTradeSuggested,
    recommendedTranches,
    rationale,
  };
}

/**
 * Run complete simulation and MEV inspection for a swap request.
 */
export function simulateSwapWithMevProtection(
  tokenIn: string,
  tokenOut: string,
  amountIn: number,
  slippageTolerancePct: number,
  availablePools: LiquidityPool[]
): SimulationResult | null {
  const routes = findBestSwapRoutes(tokenIn, tokenOut, amountIn, availablePools);
  if (routes.length === 0) return null;

  const bestRoute = routes[0];
  const minReceived = calculateMinReceived(bestRoute.finalAmountOut, slippageTolerancePct);
  const mevAnalysis = analyzeMevVulnerability(
    amountIn,
    bestRoute.finalAmountOut,
    minReceived,
    bestRoute.priceImpactPct,
    slippageTolerancePct,
    bestRoute
  );
  const protectiveSuggestions = getProtectiveSuggestions(
    mevAnalysis,
    bestRoute.priceImpactPct,
    slippageTolerancePct
  );

  return {
    route: bestRoute,
    alternativeRoutes: routes.slice(1),
    mevAnalysis,
    protectiveSuggestions,
    timestamp: Date.now(),
  };
}

/**
 * High-quality default sample liquidity pools representing active pairs on Stellar.
 */
export const DEFAULT_SAMPLE_POOLS: LiquidityPool[] = [
  {
    id: 'pool-xlm-usdc',
    address: 'SIMULATED_POOL_XLM_USDC',
    name: 'XLM / USDC Standard Pool',
    tokenA: 'XLM',
    tokenB: 'USDC',
    reserveA: 10_000_000 * 1e7, // 10M XLM
    reserveB: 1_250_000 * 1e7,  // 1.25M USDC ($0.125 / XLM)
    feeBps: 30,                 // 0.3%
    isActive: true,
  },
  {
    id: 'pool-usdc-aqua',
    address: 'SIMULATED_POOL_USDC_AQUA',
    name: 'USDC / AQUA Deep Pool',
    tokenA: 'USDC',
    tokenB: 'AQUA',
    reserveA: 2_000_000 * 1e7,   // 2M USDC
    reserveB: 400_000_000 * 1e7, // 400M AQUA ($0.005 / AQUA)
    feeBps: 30,                  // 0.3%
    isActive: true,
  },
  {
    id: 'pool-xlm-aqua',
    address: 'SIMULATED_POOL_XLM_AQUA',
    name: 'XLM / AQUA Direct Pool',
    tokenA: 'XLM',
    tokenB: 'AQUA',
    reserveA: 1_000_000 * 1e7,  // 1M XLM (shallow liquidity)
    reserveB: 25_000_000 * 1e7, // 25M AQUA
    feeBps: 50,                 // 0.5%
    isActive: true,
  },
  {
    id: 'pool-xlm-eurc',
    address: 'SIMULATED_POOL_XLM_EURC',
    name: 'XLM / EURC Forex Pool',
    tokenA: 'XLM',
    tokenB: 'EURC',
    reserveA: 5_000_000 * 1e7, // 5M XLM
    reserveB: 575_000 * 1e7,   // 575k EURC
    feeBps: 20,                // 0.2%
    isActive: true,
  },
  {
    id: 'pool-usdc-eth',
    address: 'SIMULATED_POOL_USDC_ETH',
    name: 'USDC / ETH Wrapped Bridge Pool',
    tokenA: 'USDC',
    tokenB: 'ETH',
    reserveA: 8_000_000 * 1e7, // 8M USDC
    reserveB: 2_500 * 1e7,     // 2,500 ETH ($3,200 / ETH)
    feeBps: 5,                 // 0.05%
    isActive: true,
  },
];

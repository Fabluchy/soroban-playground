// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file swapMath.test.ts
 * Unit test suite for multi-hop swap routing math, price impact calculation,
 * and MEV / sandwich attack vulnerability analysis.
 */

import {
  calculateHopAmountOut,
  calculateHopSpotPrice,
  calculatePriceImpact,
  calculateMinReceived,
  findBestSwapRoutes,
  analyzeMevVulnerability,
  getProtectiveSuggestions,
  simulateSwapWithMevProtection,
  DEFAULT_SAMPLE_POOLS,
} from '../../lib/swap/swapMath';
import type { LiquidityPool } from '../../lib/swap/types';

describe('Swap Routing Math & Constant-Product AMM Formula', () => {
  describe('calculateHopAmountOut', () => {
    it('calculates output amount correctly for 30 bps (0.3%) fee', () => {
      // 1,000 input, 100,000 reserveIn, 200,000 reserveOut, 30 bps fee
      // amountInWithFee = 1000 * 9970 = 9,970,000
      // numerator = 9,970,000 * 200,000 = 1,994,000,000,000
      // denominator = (100,000 * 10,000) + 9,970,000 = 1,009,970,000
      // amountOut = floor(1,994,000,000,000 / 1,009,970,000) = 1974
      const amountOut = calculateHopAmountOut(1000, 100_000, 200_000, 30);
      expect(amountOut).toBe(1974);
    });

    it('returns 0 when input amount is zero or negative', () => {
      expect(calculateHopAmountOut(0, 100_000, 200_000, 30)).toBe(0);
      expect(calculateHopAmountOut(-50, 100_000, 200_000, 30)).toBe(0);
    });

    it('returns 0 when pool reserves are zero or negative', () => {
      expect(calculateHopAmountOut(100, 0, 200_000, 30)).toBe(0);
      expect(calculateHopAmountOut(100, 100_000, 0, 30)).toBe(0);
      expect(calculateHopAmountOut(100, -100, 200_000, 30)).toBe(0);
    });

    it('handles zero fee (0 bps) accurately', () => {
      // 100 in, 10,000 inReserve, 10,000 outReserve
      // (100 * 10000 * 10000) / (10000 * 10000 + 100 * 10000) = 100000000 / 1010000 = 99
      const out = calculateHopAmountOut(100, 10_000, 10_000, 0);
      expect(out).toBe(99);
    });
  });

  describe('calculateHopSpotPrice', () => {
    it('returns accurate spot price ratio', () => {
      expect(calculateHopSpotPrice(100, 250)).toBe(2.5);
      expect(calculateHopSpotPrice(0, 250)).toBe(0);
    });
  });

  describe('calculatePriceImpact', () => {
    it('returns 0% for negligible trade size', () => {
      const hops = [
        {
          pool: DEFAULT_SAMPLE_POOLS[0],
          tokenIn: 'XLM',
          tokenOut: 'USDC',
          reserveIn: 10_000_000 * 1e7,
          reserveOut: 1_250_000 * 1e7,
          feeBps: 30,
          amountIn: 10 * 1e7,
          amountOut: 1.246 * 1e7,
          hopPriceImpactPct: 0.01,
        },
      ];
      const impact = calculatePriceImpact(10 * 1e7, 1.246 * 1e7, hops);
      expect(impact).toBeLessThan(0.5);
    });

    it('calculates significant price impact for large trades', () => {
      const hops = [
        {
          pool: DEFAULT_SAMPLE_POOLS[0],
          tokenIn: 'XLM',
          tokenOut: 'USDC',
          reserveIn: 1_000,
          reserveOut: 1_000,
          feeBps: 30,
          amountIn: 500,
          amountOut: 332,
          hopPriceImpactPct: 33.6,
        },
      ];
      const impact = calculatePriceImpact(500, 332, hops);
      expect(impact).toBeGreaterThan(30);
    });
  });

  describe('calculateMinReceived', () => {
    it('calculates minimum output after applying slippage tolerance', () => {
      // 1000 tokens expected, 1% slippage => 990 tokens min
      expect(calculateMinReceived(1000, 1.0)).toBe(990);
      // 1000 tokens expected, 0.5% slippage => 995 tokens min
      expect(calculateMinReceived(1000, 0.5)).toBe(995);
      // 1000 tokens expected, 2.5% slippage => 975 tokens min
      expect(calculateMinReceived(1000, 2.5)).toBe(975);
    });

    it('floors fractional stroops correctly', () => {
      // 100 tokens expected, 0.3% slippage => 99.7 => floor is 99
      expect(calculateMinReceived(100, 0.3)).toBe(99);
    });

    it('returns 0 when output is zero or slippage is 100%', () => {
      expect(calculateMinReceived(0, 1.0)).toBe(0);
      expect(calculateMinReceived(1000, 100)).toBe(0);
    });
  });

  describe('findBestSwapRoutes', () => {
    it('finds direct route between tokens with a pool', () => {
      const routes = findBestSwapRoutes('XLM', 'USDC', 1000 * 1e7, DEFAULT_SAMPLE_POOLS, 3);
      expect(routes.length).toBeGreaterThan(0);
      const directRoute = routes.find((r) => r.pathTokens.length === 2);
      expect(directRoute).toBeDefined();
      expect(directRoute?.pathTokens).toEqual(['XLM', 'USDC']);
    });

    it('identifies multi-hop route (e.g. XLM -> USDC -> AQUA)', () => {
      const routes = findBestSwapRoutes('XLM', 'AQUA', 1000 * 1e7, DEFAULT_SAMPLE_POOLS, 3);
      expect(routes.length).toBeGreaterThan(0);
      // Check if multi-hop route was found
      const multiHopRoute = routes.find(
        (r) => r.pathTokens.length === 3 && r.pathTokens[1] === 'USDC'
      );
      expect(multiHopRoute).toBeDefined();
      expect(multiHopRoute?.pathTokens).toEqual(['XLM', 'USDC', 'AQUA']);
    });

    it('marks highest output route as isBestRoute', () => {
      const routes = findBestSwapRoutes('XLM', 'AQUA', 5000 * 1e7, DEFAULT_SAMPLE_POOLS, 3);
      expect(routes.length).toBeGreaterThan(0);
      expect(routes[0].isBestRoute).toBe(true);
      // Ensure routes are sorted descending
      for (let i = 0; i < routes.length - 1; i++) {
        expect(routes[i].finalAmountOut).toBeGreaterThanOrEqual(routes[i + 1].finalAmountOut);
      }
    });

    it('returns empty array when no path exists', () => {
      const routes = findBestSwapRoutes('UNKNOWN_A', 'UNKNOWN_B', 1000, DEFAULT_SAMPLE_POOLS, 3);
      expect(routes).toEqual([]);
    });
  });
});

describe('MEV & Sandwich Attack Protection Analysis', () => {
  describe('analyzeMevVulnerability', () => {
    it('flags CRITICAL risk when slippage tolerance exceeds 2.0%', () => {
      const analysis = analyzeMevVulnerability(
        1000 * 1e7,
        125 * 1e7,
        120 * 1e7,
        0.5, // low price impact
        2.5  // excessive slippage (>2%)
      );

      expect(analysis.riskLevel).toBe('CRITICAL');
      expect(analysis.isSandwichVulnerable).toBe(true);
      expect(analysis.vulnerabilityReasons.some((r) => r.includes('2.0%'))).toBe(true);
    });

    it('flags CRITICAL risk when price impact exceeds 3.0%', () => {
      const analysis = analyzeMevVulnerability(
        1000 * 1e7,
        125 * 1e7,
        124 * 1e7,
        4.2, // high price impact (>3%)
        0.5  // tight slippage
      );

      expect(analysis.riskLevel).toBe('CRITICAL');
      expect(analysis.isSandwichVulnerable).toBe(true);
      expect(analysis.vulnerabilityReasons.some((r) => r.includes('Price impact is high'))).toBe(
        true
      );
    });

    it('flags MEDIUM risk when slippage is between 0.5% and 2.0%', () => {
      const analysis = analyzeMevVulnerability(
        1000 * 1e7,
        125 * 1e7,
        123.5 * 1e7,
        0.8, // low price impact
        1.2  // moderate slippage
      );

      expect(analysis.riskLevel).toBe('MEDIUM');
      expect(analysis.isSandwichVulnerable).toBe(false);
    });

    it('flags LOW risk when slippage is tight (<= 0.5%) and price impact is low', () => {
      const analysis = analyzeMevVulnerability(
        1000 * 1e7,
        125 * 1e7,
        124.5 * 1e7,
        0.3, // low price impact
        0.4  // tight slippage
      );

      expect(analysis.riskLevel).toBe('LOW');
      expect(analysis.isSandwichVulnerable).toBe(false);
    });

    it('calculates max extractable value (potential loss) accurately', () => {
      const analysis = analyzeMevVulnerability(
        1000,
        500, // expected
        475, // minReceived (5% loss)
        1.0,
        5.0
      );
      expect(analysis.maxExtractableValue).toBe(25);
      expect(analysis.lossPercentage).toBe(5.0);
    });
  });

  describe('getProtectiveSuggestions', () => {
    it('suggests tight slippage (0.5%) and priority gas fee when vulnerable', () => {
      const mevAnalysis = {
        riskLevel: 'CRITICAL' as const,
        isSandwichVulnerable: true,
        slippageTolerancePct: 3.0,
        priceImpactPct: 1.5,
        expectedOutput: 1000,
        minReceived: 970,
        maxExtractableValue: 30,
        lossPercentage: 3.0,
        vulnerabilityReasons: ['Slippage > 2.0%'],
      };

      const suggestions = getProtectiveSuggestions(mevAnalysis, 1.5, 3.0);
      expect(suggestions.recommendedSlippagePct).toBeLessThanOrEqual(0.5);
      expect(suggestions.recommendedGasFeeStroops).toBe(1000); // Priority bump
      expect(suggestions.enablePrivateMempool).toBe(true);
    });

    it('suggests trade splitting when price impact exceeds 3.0%', () => {
      const mevAnalysis = {
        riskLevel: 'CRITICAL' as const,
        isSandwichVulnerable: true,
        slippageTolerancePct: 0.5,
        priceImpactPct: 6.0,
        expectedOutput: 1000,
        minReceived: 995,
        maxExtractableValue: 5,
        lossPercentage: 0.5,
        vulnerabilityReasons: ['Price impact > 3.0%'],
      };

      const suggestions = getProtectiveSuggestions(mevAnalysis, 6.0, 0.5);
      expect(suggestions.splitTradeSuggested).toBe(true);
      expect(suggestions.recommendedTranches).toBeGreaterThanOrEqual(2);
    });
  });

  describe('simulateSwapWithMevProtection', () => {
    it('returns complete simulation package with route, MEV analysis, and suggestions', () => {
      const result = simulateSwapWithMevProtection(
        'XLM',
        'USDC',
        1000 * 1e7,
        2.5, // > 2% slippage
        DEFAULT_SAMPLE_POOLS
      );

      expect(result).not.toBeNull();
      expect(result?.route.pathTokens).toEqual(['XLM', 'USDC']);
      expect(result?.mevAnalysis.riskLevel).toBe('CRITICAL');
      expect(result?.mevAnalysis.isSandwichVulnerable).toBe(true);
      expect(result?.protectiveSuggestions.recommendedSlippagePct).toBeLessThanOrEqual(0.5);
    });
  });
});

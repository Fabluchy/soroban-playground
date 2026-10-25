// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import test from 'node:test';
import assert from 'node:assert/strict';
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
} from '../../lib/swap/swapMath.ts';

test('calculateHopAmountOut calculates output correctly with 30 bps fee', () => {
  const out = calculateHopAmountOut(1000, 100_000, 200_000, 30);
  assert.equal(out, 1974);
});

test('calculateHopAmountOut returns 0 for invalid inputs', () => {
  assert.equal(calculateHopAmountOut(0, 100_000, 200_000, 30), 0);
  assert.equal(calculateHopAmountOut(-10, 100_000, 200_000, 30), 0);
  assert.equal(calculateHopAmountOut(100, 0, 200_000, 30), 0);
  assert.equal(calculateHopAmountOut(100, 100_000, 0, 30), 0);
});

test('calculateHopSpotPrice calculates correct spot price', () => {
  assert.equal(calculateHopSpotPrice(100, 250), 2.5);
  assert.equal(calculateHopSpotPrice(0, 250), 0);
});

test('calculatePriceImpact computes exact price impact', () => {
  const hops = [
    {
      pool: DEFAULT_SAMPLE_POOLS[0],
      tokenIn: 'XLM',
      tokenOut: 'USDC',
      reserveIn: 1000,
      reserveOut: 1000,
      feeBps: 30,
      amountIn: 500,
      amountOut: 332,
      hopPriceImpactPct: 33.6,
    },
  ];
  const impact = calculatePriceImpact(500, 332, hops);
  assert.ok(impact > 30);
  assert.ok(impact < 40);
});

test('calculateMinReceived floors accurately across slippage tolerances', () => {
  assert.equal(calculateMinReceived(1000, 1.0), 990);
  assert.equal(calculateMinReceived(1000, 0.5), 995);
  assert.equal(calculateMinReceived(1000, 2.5), 975);
  assert.equal(calculateMinReceived(100, 0.3), 99);
  assert.equal(calculateMinReceived(0, 1.0), 0);
  assert.equal(calculateMinReceived(1000, 100), 0);
});

test('findBestSwapRoutes discovers direct and multi-hop routes', () => {
  const directRoutes = findBestSwapRoutes('XLM', 'USDC', 1000 * 1e7, DEFAULT_SAMPLE_POOLS, 3);
  assert.ok(directRoutes.length > 0);
  assert.deepEqual(directRoutes[0].pathTokens, ['XLM', 'USDC']);

  const multiHopRoutes = findBestSwapRoutes('XLM', 'AQUA', 1000 * 1e7, DEFAULT_SAMPLE_POOLS, 3);
  assert.ok(multiHopRoutes.length > 0);
  const foundMultiHop = multiHopRoutes.some(
    (r) => r.pathTokens.length === 3 && r.pathTokens[1] === 'USDC'
  );
  assert.ok(foundMultiHop, 'Should find XLM -> USDC -> AQUA multi-hop route');
  assert.equal(multiHopRoutes[0].isBestRoute, true);
});

test('analyzeMevVulnerability flags CRITICAL risk for slippage > 2.0%', () => {
  const analysis = analyzeMevVulnerability(
    1000 * 1e7,
    125 * 1e7,
    120 * 1e7,
    0.5,
    2.5 // > 2.0%
  );
  assert.equal(analysis.riskLevel, 'CRITICAL');
  assert.equal(analysis.isSandwichVulnerable, true);
  assert.ok(analysis.vulnerabilityReasons.some((r) => r.includes('2.0%')));
});

test('analyzeMevVulnerability flags CRITICAL risk for price impact > 3.0%', () => {
  const analysis = analyzeMevVulnerability(
    1000 * 1e7,
    125 * 1e7,
    124 * 1e7,
    4.5, // > 3.0%
    0.5
  );
  assert.equal(analysis.riskLevel, 'CRITICAL');
  assert.equal(analysis.isSandwichVulnerable, true);
});

test('analyzeMevVulnerability flags MEDIUM risk for 0.5% < slippage <= 2.0%', () => {
  const analysis = analyzeMevVulnerability(
    1000 * 1e7,
    125 * 1e7,
    123.5 * 1e7,
    0.8,
    1.2
  );
  assert.equal(analysis.riskLevel, 'MEDIUM');
  assert.equal(analysis.isSandwichVulnerable, false);
});

test('analyzeMevVulnerability flags LOW risk for tight slippage <= 0.5%', () => {
  const analysis = analyzeMevVulnerability(
    1000 * 1e7,
    125 * 1e7,
    124.5 * 1e7,
    0.3,
    0.4
  );
  assert.equal(analysis.riskLevel, 'LOW');
  assert.equal(analysis.isSandwichVulnerable, false);
});

test('getProtectiveSuggestions generates accurate parameters and rationales', () => {
  const analysis = analyzeMevVulnerability(
    1000 * 1e7,
    125 * 1e7,
    120 * 1e7,
    0.5,
    2.5
  );
  const suggestions = getProtectiveSuggestions(analysis, 0.5, 2.5);
  assert.ok(suggestions.recommendedSlippagePct <= 0.5);
  assert.equal(suggestions.recommendedGasFeeStroops, 1000);
  assert.equal(suggestions.enablePrivateMempool, true);
});

test('simulateSwapWithMevProtection runs end-to-end simulation', () => {
  const res = simulateSwapWithMevProtection(
    'XLM',
    'USDC',
    1000 * 1e7,
    2.5,
    DEFAULT_SAMPLE_POOLS
  );
  assert.ok(res !== null);
  assert.equal(res?.mevAnalysis.riskLevel, 'CRITICAL');
  assert.equal(res?.mevAnalysis.isSandwichVulnerable, true);
  assert.ok(res?.protectiveSuggestions.recommendedSlippagePct <= 0.5);
});

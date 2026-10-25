// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file types.ts
 * Strict TypeScript definitions for Multi-Asset Token Swap Simulation,
 * Multi-Hop Routing, and MEV / Sandwich Attack Protection.
 */

export interface LiquidityPool {
  id: string | number;
  address: string;
  name: string;
  tokenA: string;
  tokenB: string;
  reserveA: number; // In Stroops or base units
  reserveB: number; // In Stroops or base units
  feeBps: number;   // Basis points (e.g. 30 = 0.3%, 5 = 0.05%)
  isActive: boolean;
}

export interface SwapHop {
  pool: LiquidityPool;
  tokenIn: string;
  tokenOut: string;
  reserveIn: number;
  reserveOut: number;
  feeBps: number;
  amountIn: number;
  amountOut: number;
  hopPriceImpactPct: number;
}

export interface SwapRoute {
  id: string;
  pathTokens: string[];
  hops: SwapHop[];
  initialAmountIn: number;
  finalAmountOut: number;
  totalFeeBps: number;
  priceImpactPct: number;
  executionPrice: number; // finalAmountOut / initialAmountIn
  isBestRoute?: boolean;
}

export type MevRiskLevel = 'LOW' | 'MEDIUM' | 'CRITICAL';

export interface MevAnalysis {
  riskLevel: MevRiskLevel;
  isSandwichVulnerable: boolean;
  slippageTolerancePct: number;
  priceImpactPct: number;
  expectedOutput: number;
  minReceived: number;
  maxExtractableValue: number; // ExpectedOut - MinReceived
  lossPercentage: number;      // Max loss %
  vulnerabilityReasons: string[];
}

export interface ProtectiveSuggestions {
  recommendedSlippagePct: number;
  recommendedGasFeeStroops: number;
  enablePrivateMempool: boolean;
  splitTradeSuggested: boolean;
  recommendedTranches?: number;
  rationale: string;
}

export interface SimulationResult {
  route: SwapRoute;
  alternativeRoutes: SwapRoute[];
  mevAnalysis: MevAnalysis;
  protectiveSuggestions: ProtectiveSuggestions;
  timestamp: number;
}

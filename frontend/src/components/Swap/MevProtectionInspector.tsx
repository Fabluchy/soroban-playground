// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file MevProtectionInspector.tsx
 * Multi-Asset Token Swap Simulation, Slippage Analysis, and MEV / Sandwich Attack
 * Protection Visualizer Modal for the Stellar Soroban ecosystem.
 */

"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  Shield,
  Zap,
  ArrowRight,
  ChevronRight,
  Copy,
  Check,
  AlertTriangle,
  Info,
  X,
  Sliders,
  Sparkles,
  Lock,
  Layers,
  TrendingDown,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import {
  LiquidityPool,
  SwapRoute,
  SwapHop,
  SimulationResult,
} from "../../lib/swap/types";
import {
  simulateSwapWithMevProtection,
  DEFAULT_SAMPLE_POOLS,
} from "../../lib/swap/swapMath";

export interface MevProtectionInspectorProps {
  isOpen?: boolean;
  onClose?: () => void;
  initialTokenIn?: string;
  initialTokenOut?: string;
  initialAmountIn?: number;
  initialSlippage?: number;
  pools?: LiquidityPool[];
  onApplySettings?: (settings: {
    slippage: number;
    priorityFee: number;
    privateRouting: boolean;
  }) => void;
  onExecuteSwap?: (route: SwapRoute, minReceived: number) => void;
  className?: string;
}

const PRESET_SLIPPAGES = [0.1, 0.5, 1.0, 2.0];
const AVAILABLE_TOKENS = ["XLM", "USDC", "AQUA", "EURC", "ETH"];

export default function MevProtectionInspector({
  isOpen = true,
  onClose,
  initialTokenIn = "XLM",
  initialTokenOut = "AQUA",
  initialAmountIn = 1000,
  initialSlippage = 2.5, // Intentionally set to demonstrate MEV detection (>2%)
  pools = DEFAULT_SAMPLE_POOLS,
  onApplySettings,
  onExecuteSwap,
  className = "",
}: MevProtectionInspectorProps) {
  // Input parameters state
  const [tokenIn, setTokenIn] = useState<string>(initialTokenIn);
  const [tokenOut, setTokenOut] = useState<string>(initialTokenOut);
  const [amountIn, setAmountIn] = useState<number>(initialAmountIn);
  const [slippage, setSlippage] = useState<number>(initialSlippage);
  const [customSlippage, setCustomSlippage] = useState<string>(
    initialSlippage.toString()
  );
  const [priorityFee, setPriorityFee] = useState<number>(100);
  const [privateRouting, setPrivateRouting] = useState<boolean>(false);

  // UI state
  const [selectedHop, setSelectedHop] = useState<SwapHop | null>(null);
  const [copiedPoolId, setCopiedPoolId] = useState<string | null>(null);
  const [protectiveApplied, setProtectiveApplied] = useState<boolean>(false);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  // Close modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Scaled amount in stroops (1e7)
  const scaledAmountIn = useMemo(() => {
    return Math.floor((amountIn || 0) * 1e7);
  }, [amountIn]);

  // Execute instantaneous simulation
  const simulation: SimulationResult | null = useMemo(() => {
    if (!tokenIn || !tokenOut || tokenIn === tokenOut || scaledAmountIn <= 0) {
      return null;
    }
    return simulateSwapWithMevProtection(
      tokenIn,
      tokenOut,
      scaledAmountIn,
      slippage,
      pools
    );
  }, [tokenIn, tokenOut, scaledAmountIn, slippage, pools]);

  // Active route (best route by default or user-selected alternative)
  const activeRoute = useMemo<SwapRoute | null>(() => {
    if (!simulation) return null;
    if (selectedRouteId && simulation.alternativeRoutes) {
      const alt = simulation.alternativeRoutes.find(
        (r) => r.id === selectedRouteId
      );
      if (alt) return alt;
    }
    return simulation.route;
  }, [simulation, selectedRouteId]);

  // Copy pool address helper
  const handleCopyAddress = useCallback(
    (address: string, poolId: string | number) => {
      navigator.clipboard?.writeText(address);
      setCopiedPoolId(String(poolId));
      setTimeout(() => setCopiedPoolId(null), 2000);
    },
    []
  );

  // Handle slippage change
  const handleSlippagePreset = (preset: number) => {
    setSlippage(preset);
    setCustomSlippage(preset.toString());
    setProtectiveApplied(false);
  };

  const handleCustomSlippageChange = (val: string) => {
    setCustomSlippage(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 50) {
      setSlippage(parsed);
      setProtectiveApplied(false);
    }
  };

  // Apply protective settings one-click handler
  const handleApplyProtective = () => {
    if (!simulation) return;
    const { recommendedSlippagePct, recommendedGasFeeStroops, enablePrivateMempool } =
      simulation.protectiveSuggestions;

    setSlippage(recommendedSlippagePct);
    setCustomSlippage(recommendedSlippagePct.toString());
    setPriorityFee(recommendedGasFeeStroops);
    setPrivateRouting(enablePrivateMempool);
    setProtectiveApplied(true);

    if (onApplySettings) {
      onApplySettings({
        slippage: recommendedSlippagePct,
        priorityFee: recommendedGasFeeStroops,
        privateRouting: enablePrivateMempool,
      });
    }
  };

  if (!isOpen) return null;

  const isSandwichVulnerable = simulation?.mevAnalysis.isSandwichVulnerable ?? false;
  const riskLevel = simulation?.mevAnalysis.riskLevel ?? "LOW";
  const formattedExpectedOut = activeRoute
    ? (activeRoute.finalAmountOut / 1e7).toLocaleString("en-US", {
        maximumFractionDigits: 6,
      })
    : "0";
  const formattedMinReceived = simulation
    ? (simulation.mevAnalysis.minReceived / 1e7).toLocaleString("en-US", {
        maximumFractionDigits: 6,
      })
    : "0";
  const formattedMaxLoss = simulation
    ? (simulation.mevAnalysis.maxExtractableValue / 1e7).toLocaleString(
        "en-US",
        { maximumFractionDigits: 6 }
      )
    : "0";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mev-inspector-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md overflow-y-auto"
    >
      <div
        className={`relative w-full max-w-4xl my-8 rounded-2xl border border-gray-800 bg-gray-950/95 p-6 shadow-2xl shadow-indigo-950/30 text-gray-100 ${className}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
                riskLevel === "CRITICAL"
                  ? "border-red-500/30 bg-red-500/10 text-red-400"
                  : riskLevel === "MEDIUM"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              }`}
            >
              {riskLevel === "CRITICAL" ? (
                <ShieldAlert className="h-6 w-6 animate-pulse" />
              ) : riskLevel === "MEDIUM" ? (
                <AlertTriangle className="h-6 w-6" />
              ) : (
                <ShieldCheck className="h-6 w-6" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2
                  id="mev-inspector-title"
                  className="text-lg font-semibold tracking-tight text-white"
                >
                  Swap Simulation & MEV Protection Visualizer
                </h2>
                <span className="rounded-full border border-gray-700 bg-gray-900 px-2.5 py-0.5 text-[11px] font-mono font-medium text-gray-300">
                  Stellar / Soroban
                </span>
              </div>
              <p className="text-xs text-gray-400">
                Multi-hop routing path simulation, price impact calculation, and
                sandwich attack defense.
              </p>
            </div>
          </div>

          {onClose && (
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
              aria-label="Close modal"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Swap Parameters Input Bar */}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-4 rounded-xl border border-gray-800/80 bg-gray-900/40 p-3.5">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Input Token
            </label>
            <select
              value={tokenIn}
              onChange={(e) => {
                setTokenIn(e.target.value);
                setSelectedRouteId(null);
              }}
              className="mt-1 w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm font-semibold text-white focus:border-indigo-500 focus:outline-none"
            >
              {AVAILABLE_TOKENS.map((tok) => (
                <option key={tok} value={tok} disabled={tok === tokenOut}>
                  {tok}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Output Token
            </label>
            <select
              value={tokenOut}
              onChange={(e) => {
                setTokenOut(e.target.value);
                setSelectedRouteId(null);
              }}
              className="mt-1 w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm font-semibold text-white focus:border-indigo-500 focus:outline-none"
            >
              {AVAILABLE_TOKENS.map((tok) => (
                <option key={tok} value={tok} disabled={tok === tokenIn}>
                  {tok}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
              Swap Amount ({tokenIn})
            </label>
            <input
              type="number"
              min="0.1"
              step="any"
              value={amountIn || ""}
              onChange={(e) => setAmountIn(parseFloat(e.target.value) || 0)}
              className="mt-1 w-full rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm font-semibold text-white focus:border-indigo-500 focus:outline-none"
              placeholder="1000"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium uppercase tracking-wider text-gray-400">
                Slippage Tolerance
              </label>
              {slippage > 2.0 && (
                <span className="text-[10px] font-semibold text-red-400">
                  Vulnerable (&gt;2%)
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-1">
              {PRESET_SLIPPAGES.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => handleSlippagePreset(preset)}
                  className={`flex-1 rounded-md px-1.5 py-1.5 text-xs font-semibold transition-all ${
                    slippage === preset
                      ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/50"
                      : "bg-gray-800/80 text-gray-300 hover:bg-gray-700"
                  }`}
                >
                  {preset}%
                </button>
              ))}
              <div className="relative w-16">
                <input
                  type="text"
                  value={customSlippage}
                  onChange={(e) => handleCustomSlippageChange(e.target.value)}
                  className={`w-full rounded-md border px-1.5 py-1 text-center text-xs font-mono font-semibold focus:outline-none ${
                    slippage > 2.0
                      ? "border-red-500/60 bg-red-950/20 text-red-300"
                      : "border-gray-800 bg-gray-900 text-gray-200"
                  }`}
                  placeholder="2.0"
                />
              </div>
            </div>
          </div>
        </div>

        {/* MEV Threat & Sandwich Attack Status Banner */}
        <div className="mt-4">
          {riskLevel === "CRITICAL" ? (
            <div
              data-testid="mev-alert-critical"
              className="rounded-xl border border-red-500/30 bg-gradient-to-r from-red-950/40 via-red-900/20 to-transparent p-4 text-red-200 shadow-inner"
            >
              <div className="flex items-start gap-3">
                <ShieldAlert className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5 animate-bounce" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-red-400">
                      High MEV Vulnerability
                    </span>
                    <span className="text-xs font-mono text-red-300">
                      {slippage > 2
                        ? `Slippage: ${slippage.toFixed(1)}% > 2.0%`
                        : `Price impact: ${simulation?.mevAnalysis.priceImpactPct.toFixed(2)}%`}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-red-200/90 leading-relaxed">
                    {simulation?.mevAnalysis.vulnerabilityReasons.join(" ")} Potential output loss up to{" "}
                    <strong className="text-white font-mono">
                      {formattedMaxLoss} {tokenOut} ({simulation?.mevAnalysis.lossPercentage}%)
                    </strong>{" "}
                    under the configured minimum received bound. This is a simulation estimate, not a prediction of an actual attack.
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid="apply-protective-btn"
                      onClick={handleApplyProtective}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-red-700/30 hover:bg-red-500 transition-colors"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Apply Protective Settings (Tighten to 0.5% Slippage)
                    </button>
                    {protectiveApplied && (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-medium">
                        <Check className="h-3.5 w-3.5" /> Protective settings applied!
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : riskLevel === "MEDIUM" ? (
            <div
              data-testid="mev-alert-medium"
              className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 text-amber-200"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-amber-400">
                      Moderate Slippage Exposure
                    </span>
                    <span className="text-xs font-mono text-amber-300">
                      Slippage: {slippage.toFixed(1)}%
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-amber-200/80">
                    Slippage between 0.5% and 2.0% creates minor MEV exposure.
                    Consider tightening slippage to 0.5% for deeper protection.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div
              data-testid="mev-alert-low"
              className="rounded-xl border border-emerald-500/20 bg-emerald-950/15 p-3.5 text-emerald-200"
            >
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-emerald-400 flex-shrink-0" />
                <div className="flex-1 flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-emerald-400">
                      MEV Protected
                    </span>
                    <span className="text-xs text-emerald-300/80">
                      Slippage bound is {slippage.toFixed(1)}%. Low risk is a
                      heuristic and does not guarantee protection from attacks.
                    </span>
                  </div>
                  <span className="text-xs font-mono text-emerald-400">
                    Safe Execution Bound
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Interactive Multi-Hop Routing Diagram */}
        <div className="mt-5 rounded-xl border border-gray-800 bg-gray-900/60 p-4">
          <div className="flex items-center justify-between pb-3 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-indigo-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-300">
                Multi-Hop Execution Path
              </h3>
              {activeRoute && (
                <span className="rounded-full bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
                  {activeRoute.hops.length} Hop
                  {activeRoute.hops.length > 1 ? "s" : ""}
                </span>
              )}
            </div>

            {simulation && simulation.alternativeRoutes.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-400">Alternative Paths:</span>
                <button
                  type="button"
                  onClick={() => setSelectedRouteId(null)}
                  className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                    !selectedRouteId
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:text-white"
                  }`}
                >
                  Best Route ({simulation.route.hops.length} hops)
                </button>
                {simulation.alternativeRoutes.map((alt, idx) => (
                  <button
                    key={alt.id}
                    type="button"
                    onClick={() => setSelectedRouteId(alt.id)}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                      selectedRouteId === alt.id
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-800 text-gray-400 hover:text-white"
                    }`}
                  >
                    Alt {idx + 1} ({alt.hops.length} hops)
                  </button>
                ))}
              </div>
            )}
          </div>

          {activeRoute ? (
            <div className="mt-4 flex flex-col items-center">
              {/* Horizontal route chain */}
              <div className="flex items-center justify-center flex-wrap gap-2 w-full py-3">
                {activeRoute.hops.map((hop, index) => {
                  const isFirst = index === 0;
                  const isLast = index === activeRoute.hops.length - 1;

                  return (
                    <React.Fragment key={`${hop.pool.id}-${index}`}>
                      {/* Token In Node */}
                      {isFirst && (
                        <div className="flex flex-col items-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-indigo-500/40 bg-indigo-950/40 font-bold text-sm text-indigo-200 shadow-md">
                            {hop.tokenIn}
                          </div>
                          <span className="mt-1 text-[11px] font-mono text-gray-400">
                            {(amountIn || 0).toLocaleString()} {hop.tokenIn}
                          </span>
                        </div>
                      )}

                      {/* Connector with Interactive Pool Fee Badge */}
                      <div className="flex flex-col items-center px-1">
                        <button
                          type="button"
                          onClick={() => setSelectedHop(hop)}
                          className="group relative flex items-center gap-1.5 rounded-full border border-gray-700 bg-gray-800/90 px-3 py-1.5 text-xs text-gray-300 hover:border-indigo-400 hover:bg-gray-750 hover:text-white transition-all shadow-sm"
                          title="Click to inspect pool liquidity and address"
                        >
                          <span className="font-semibold text-indigo-400">
                            {hop.pool.name.split(" ")[0]}
                          </span>
                          <span className="rounded bg-indigo-500/20 px-1.5 py-0.2 text-[10px] font-mono font-bold text-indigo-300">
                            {(hop.feeBps / 100).toFixed(2)}% Fee
                          </span>
                          <ChevronRight className="h-3 w-3 text-gray-400 group-hover:translate-x-0.5 transition-transform" />
                        </button>

                        <div className="flex items-center gap-1 text-[10px] text-gray-500 mt-1">
                          <ArrowRight className="h-3 w-3" />
                          <span>Impact: {hop.hopPriceImpactPct.toFixed(2)}%</span>
                        </div>
                      </div>

                      {/* Intermediate Token Node or Final Token Node */}
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-12 w-12 items-center justify-center rounded-2xl border font-bold text-sm shadow-md ${
                            isLast
                              ? "border-emerald-500/40 bg-emerald-950/40 text-emerald-200"
                              : "border-gray-700 bg-gray-800 text-gray-200"
                          }`}
                        >
                          {hop.tokenOut}
                        </div>
                        <span className="mt-1 text-[11px] font-mono text-gray-400">
                          {(hop.amountOut / 1e7).toLocaleString("en-US", {
                            maximumFractionDigits: 4,
                          })}{" "}
                          {hop.tokenOut}
                        </span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Pool Inspector Popover Card (when a hop is selected) */}
              {selectedHop && (
                <div className="mt-3 w-full rounded-xl border border-indigo-500/30 bg-gray-950 p-4 transition-all animate-fadeIn">
                  <div className="flex items-center justify-between pb-2 border-b border-gray-800">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">
                        Pool Inspector: {selectedHop.pool.name}
                      </span>
                      <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] font-mono text-gray-300">
                        Fee: {(selectedHop.feeBps / 100).toFixed(2)}% ({selectedHop.feeBps} bps)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedHop(null)}
                      className="text-gray-400 hover:text-white text-xs"
                    >
                      Close ✕
                    </button>
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <p className="text-gray-500 text-[10px] uppercase">
                        Contract Address
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="font-mono text-gray-300 truncate max-w-[180px]">
                          {selectedHop.pool.address}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopyAddress(
                              selectedHop.pool.address,
                              selectedHop.pool.id
                            )
                          }
                          className="rounded p-1 text-gray-400 hover:text-white hover:bg-gray-800"
                          title="Copy address"
                        >
                          {copiedPoolId === String(selectedHop.pool.id) ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div>
                      <p className="text-gray-500 text-[10px] uppercase">
                        {selectedHop.tokenIn} Reserves
                      </p>
                      <p className="mt-1 font-mono font-medium text-gray-200">
                        {(selectedHop.reserveIn / 1e7).toLocaleString()}{" "}
                        {selectedHop.tokenIn}
                      </p>
                    </div>

                    <div>
                      <p className="text-gray-500 text-[10px] uppercase">
                        {selectedHop.tokenOut} Reserves
                      </p>
                      <p className="mt-1 font-mono font-medium text-gray-200">
                        {(selectedHop.reserveOut / 1e7).toLocaleString()}{" "}
                        {selectedHop.tokenOut}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-gray-500 text-xs">
              No tradeable routing path found between {tokenIn} and {tokenOut}.
            </div>
          )}
        </div>

        {/* Protective Parameter Suggestions & Simulation Metrics */}
        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Left: Protective Suggestions Card */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <div className="flex items-center gap-2 pb-2 border-b border-gray-800">
              <Shield className="h-4 w-4 text-emerald-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-300">
                Front-Running & MEV Defenses
              </h3>
            </div>

            <div className="mt-3 space-y-2.5 text-xs">
              <div className="flex items-center justify-between rounded-lg bg-gray-950/60 p-2.5 border border-gray-800/60">
                <div>
                  <span className="font-medium text-gray-200">
                    Recommended Slippage
                  </span>
                  <p className="text-[11px] text-gray-400">
                    Calculated based on path liquidity depth.
                  </p>
                </div>
                <span className="rounded bg-indigo-500/10 border border-indigo-500/30 px-2 py-1 font-mono font-bold text-indigo-300">
                  {simulation?.protectiveSuggestions.recommendedSlippagePct ?? 0.5}%
                </span>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-gray-950/60 p-2.5 border border-gray-800/60">
                <div>
                  <span className="font-medium text-gray-200">
                    Priority Network Fee
                  </span>
                  <p className="text-[11px] text-gray-400">
                    Suggested value only; the submitting service controls the actual fee.
                  </p>
                </div>
                <div className="flex items-center gap-1 font-mono font-semibold text-gray-200">
                  <Zap className="h-3.5 w-3.5 text-amber-400" />
                  <span>
                    {simulation?.protectiveSuggestions.recommendedGasFeeStroops ?? 100}{" "}
                    stroops
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg bg-gray-950/60 p-2.5 border border-gray-800/60">
                <div>
                  <span className="font-medium text-gray-200">
                    Private Mempool Submission
                  </span>
                  <p className="text-[11px] text-gray-400">
                    Preference for a private submission path, if supported by the connected swap service.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={privateRouting}
                    onChange={(e) => setPrivateRouting(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
                </label>
              </div>

              {simulation?.protectiveSuggestions.splitTradeSuggested && (
                <div className="rounded-lg bg-amber-950/20 p-2.5 border border-amber-500/30 text-amber-200">
                  <span className="font-semibold text-[11px]">
                    Trade Splitting Recommended:
                  </span>
                  <p className="text-[11px] text-amber-300/80 mt-0.5">
                    Order size causes significant price impact. Consider
                    splitting into{" "}
                    <strong>
                      {simulation.protectiveSuggestions.recommendedTranches}{" "}
                      tranches
                    </strong>{" "}
                    to minimize execution penalties.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Right: Simulation Financial Metrics */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
            <div className="flex items-center gap-2 pb-2 border-b border-gray-800">
              <Sliders className="h-4 w-4 text-indigo-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-300">
                Financial Simulation Output
              </h3>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-gray-950/60 p-2.5 border border-gray-800/60">
                <span className="text-[10px] uppercase text-gray-500">
                  Expected Output
                </span>
                <p className="mt-1 font-mono text-sm font-bold text-white">
                  {formattedExpectedOut} {tokenOut}
                </p>
              </div>

              <div className="rounded-lg bg-gray-950/60 p-2.5 border border-gray-800/60">
                <span className="text-[10px] uppercase text-gray-500">
                  Minimum Received
                </span>
                <p className="mt-1 font-mono text-sm font-bold text-emerald-400">
                  {formattedMinReceived} {tokenOut}
                </p>
              </div>

              <div className="rounded-lg bg-gray-950/60 p-2.5 border border-gray-800/60">
                <span className="text-[10px] uppercase text-gray-500">
                  Price Impact
                </span>
                <p
                  className={`mt-1 font-mono text-sm font-bold ${
                    (activeRoute?.priceImpactPct ?? 0) > 3.0
                      ? "text-red-400"
                      : (activeRoute?.priceImpactPct ?? 0) > 1.0
                      ? "text-amber-400"
                      : "text-emerald-400"
                  }`}
                >
                  {activeRoute ? activeRoute.priceImpactPct.toFixed(2) : "0.00"}%
                </p>
              </div>

              <div className="rounded-lg bg-gray-950/60 p-2.5 border border-gray-800/60">
                <span className="text-[10px] uppercase text-gray-500">
                  Max Extractable Value
                </span>
                <p className="mt-1 font-mono text-sm font-bold text-red-400">
                  {formattedMaxLoss} {tokenOut}
                </p>
              </div>
            </div>

            {/* Total Fee & Effective Rate */}
            <div className="mt-3 rounded-lg bg-gray-950/40 p-2.5 border border-gray-800/60 flex items-center justify-between text-xs font-mono text-gray-400">
              <span>
                Rate: 1 {tokenIn} ≈{" "}
                {activeRoute
                  ? activeRoute.executionPrice.toFixed(4)
                  : "0.0000"}{" "}
                {tokenOut}
              </span>
              <span>
                Total LP Fee:{" "}
                {activeRoute
                  ? (activeRoute.totalFeeBps / 100).toFixed(2)
                  : "0.00"}%
              </span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="mt-6 flex items-center justify-between pt-4 border-t border-gray-800/80">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Lock className="h-3.5 w-3.5 text-indigo-400" />
            <span>Deterministic constant-product AMM simulation</span>
          </div>

          <div className="flex items-center gap-2">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-2 text-xs font-semibold text-gray-300 hover:bg-gray-800 transition-colors"
              >
                Close
              </button>
            )}

            {onExecuteSwap && (
              <button
                type="button"
                disabled={!activeRoute || isSandwichVulnerable}
                onClick={() => {
                  if (activeRoute && simulation) {
                    onExecuteSwap(
                      activeRoute,
                      simulation.mevAnalysis.minReceived
                    );
                  }
                }}
                className={`rounded-lg px-4 py-2 text-xs font-semibold transition-all ${
                  !activeRoute || isSandwichVulnerable
                    ? "cursor-not-allowed border border-gray-800 bg-gray-900 text-gray-500"
                    : "bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500"
                }`}
              >
                Execute Swap
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

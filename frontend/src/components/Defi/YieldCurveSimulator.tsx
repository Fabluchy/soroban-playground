"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Download, Printer, RotateCcw } from "lucide-react";
import {
  concentratedRelativeValue,
  estimatedFeeApr,
  impermanentLoss,
} from "./yieldCurveMath";

type Scenario = { priceChangePct: number; impermanentLossPct: number; concentratedReturnPct: number };
const MIN_CHANGE = -90;
const MAX_CHANGE = 500;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);

export default function YieldCurveSimulator() {
  const [volume, setVolume] = useState(1_000_000);
  const [feeBps, setFeeBps] = useState(30);
  const [share, setShare] = useState(1);
  const [capital, setCapital] = useState(10_000);
  const [lowerPct, setLowerPct] = useState(-50);
  const [upperPct, setUpperPct] = useState(100);
  const [activePct, setActivePct] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<"lower" | "upper" | null>(null);

  const lower = 1 + lowerPct / 100;
  const upper = 1 + upperPct / 100;
  const feeApr = estimatedFeeApr(volume, feeBps, share, capital);
  const scenarios = useMemo<Scenario[]>(() => Array.from({ length: 120 }, (_, i) => {
    const priceChangePct = MIN_CHANGE + (MAX_CHANGE - MIN_CHANGE) * i / 119;
    const ratio = 1 + priceChangePct / 100;
    return {
      priceChangePct,
      impermanentLossPct: impermanentLoss(ratio) * 100,
      concentratedReturnPct: (concentratedRelativeValue(ratio, lower, upper) + feeApr * 0.25) * 100,
    };
  }), [lower, upper, feeApr]);
  const activeRatio = 1 + activePct / 100;
  const activeIl = impermanentLoss(activeRatio) * 100;
  const activeConcentrated = (concentratedRelativeValue(activeRatio, lower, upper) + feeApr * 0.25) * 100;

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = bounds.width * dpr;
    canvas.height = bounds.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const w = bounds.width, h = bounds.height;
    const pad = { left: 50, right: 18, top: 18, bottom: 30 };
    const x = (pct: number) => pad.left + ((pct - MIN_CHANGE) / (MAX_CHANGE - MIN_CHANGE)) * (w - pad.left - pad.right);
    const all = scenarios.flatMap((s) => [s.impermanentLossPct, s.concentratedReturnPct]);
    const yMin = Math.min(-70, Math.floor(Math.min(...all) / 10) * 10);
    const yMax = Math.max(40, Math.ceil(Math.max(...all) / 10) * 10);
    const y = (v: number) => pad.top + ((yMax - v) / (yMax - yMin)) * (h - pad.top - pad.bottom);
    ctx.font = "11px system-ui";
    ctx.strokeStyle = "#263449"; ctx.fillStyle = "#93a4ba"; ctx.lineWidth = 1;
    for (let v = Math.ceil(yMin / 20) * 20; v <= yMax; v += 20) {
      ctx.beginPath(); ctx.moveTo(pad.left, y(v)); ctx.lineTo(w - pad.right, y(v)); ctx.stroke();
      ctx.fillText(`${v}%`, 5, y(v) + 4);
    }
    for (let v = -0; v <= 500; v += 100) {
      ctx.beginPath(); ctx.moveTo(x(v), pad.top); ctx.lineTo(x(v), h - pad.bottom); ctx.stroke();
      ctx.fillText(`${v}%`, x(v) - 10, h - 8);
    }
    // Shade prices outside the selected concentrated liquidity band.
    ctx.fillStyle = "rgba(245, 158, 11, .08)";
    ctx.fillRect(pad.left, pad.top, Math.max(0, x(lowerPct) - pad.left), h - pad.top - pad.bottom);
    ctx.fillRect(x(upperPct), pad.top, Math.max(0, w - pad.right - x(upperPct)), h - pad.top - pad.bottom);
    const drawLine = (key: "impermanentLossPct" | "concentratedReturnPct", color: string) => {
      ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
      scenarios.forEach((s, i) => i ? ctx.lineTo(x(s.priceChangePct), y(s[key])) : ctx.moveTo(x(s.priceChangePct), y(s[key])));
      ctx.stroke();
    };
    drawLine("impermanentLossPct", "#fb7185");
    drawLine("concentratedReturnPct", "#38bdf8");
    // Current price marker and the two draggable range bounds.
    ctx.setLineDash([4, 4]); ctx.strokeStyle = "#f8fafc"; ctx.beginPath(); ctx.moveTo(x(activePct), pad.top); ctx.lineTo(x(activePct), h - pad.bottom); ctx.stroke(); ctx.setLineDash([]);
    [lowerPct, upperPct].forEach((v) => {
      ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x(v), pad.top); ctx.lineTo(x(v), h - pad.bottom); ctx.stroke();
      ctx.fillStyle = "#fbbf24"; ctx.beginPath(); ctx.arc(x(v), pad.top + 5, 5, 0, Math.PI * 2); ctx.fill();
    });
  }, [activePct, lowerPct, upperPct, scenarios]);

  useEffect(() => {
    drawChart();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(drawChart);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawChart]);

  const chartPctAt = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clamp(MIN_CHANGE + ((event.clientX - rect.left - 50) / (rect.width - 68)) * (MAX_CHANGE - MIN_CHANGE), MIN_CHANGE, MAX_CHANGE);
  };
  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const pct = chartPctAt(event);
    const lowerDistance = Math.abs(pct - lowerPct), upperDistance = Math.abs(pct - upperPct);
    if (Math.min(lowerDistance, upperDistance) < 24) {
      dragRef.current = lowerDistance <= upperDistance ? "lower" : "upper";
      event.currentTarget.setPointerCapture(event.pointerId);
    } else setActivePct(Math.round(pct));
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const pct = chartPctAt(event);
    if (dragRef.current === "lower") setLowerPct(Math.round(clamp(pct, -90, upperPct - 5)));
    else if (dragRef.current === "upper") setUpperPct(Math.round(clamp(pct, lowerPct + 5, 500)));
    else if (event.buttons) setActivePct(Math.round(pct));
  };
  const exportJson = () => {
    const config = { model: "Soroban constant-product AMM x*y=k", volume, feeBps, liquiditySharePct: share, capital, range: { lowerPct, upperPct }, scenarios };
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "liquidity-yield-scenario.json"; link.click(); URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-slate-100 md:p-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-[.2em] text-cyan-400">Soroban · DeFi Lab</p><h1 className="mt-2 text-2xl font-bold md:text-3xl">Liquidity yield simulator</h1><p className="mt-1 max-w-2xl text-sm text-slate-400">Explore impermanent loss, estimated trading fees and concentrated liquidity across price moves from −90% to +500%.</p></div>
          <div className="flex gap-2 print:hidden"><button onClick={exportJson} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-cyan-400"><Download size={16}/> Export JSON</button><button onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-cyan-400"><Printer size={16}/> Print report</button></div>
        </header>
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/80 p-5" aria-label="Simulation parameters">
            <div className="flex items-center justify-between"><h2 className="font-semibold">Pool assumptions</h2><button aria-label="Reset parameters" title="Reset parameters" onClick={() => { setVolume(1_000_000); setFeeBps(30); setShare(1); setCapital(10_000); setLowerPct(-50); setUpperPct(100); setActivePct(0); }} className="text-slate-400 hover:text-white"><RotateCcw size={15}/></button></div>
            <Slider label="Daily pool volume" value={volume} min={10_000} max={10_000_000} step={10_000} display={money(volume)} onChange={setVolume}/>
            <Slider label="Swap fee" value={feeBps} min={1} max={100} step={1} display={`${(feeBps / 100).toFixed(2)}%`} onChange={setFeeBps}/>
            <Slider label="Your share of pool fees" value={share} min={0.01} max={25} step={0.01} display={`${share.toFixed(2)}%`} onChange={setShare}/>
            <Slider label="Capital deposited" value={capital} min={100} max={1_000_000} step={100} display={money(capital)} onChange={setCapital}/>
            <div className="border-t border-slate-800 pt-4"><h3 className="mb-3 text-sm font-medium">Concentrated range</h3><Slider label="Lower price change" value={lowerPct} min={-90} max={Math.min(upperPct - 5, 499)} step={1} display={`${lowerPct}%`} onChange={setLowerPct}/><div className="mt-4"><Slider label="Upper price change" value={upperPct} min={Math.max(lowerPct + 5, -89)} max={500} step={1} display={`+${upperPct}%`} onChange={setUpperPct}/></div></div>
          </section>
          <div className="space-y-4">
            <section className="grid gap-3 sm:grid-cols-3" aria-label="Yield estimates">
              <Metric label="Estimated fee APY" value={`${(feeApr * 100).toFixed(1)}%`} detail="Simple annualized fees · assumes volume stays constant" color="text-emerald-300"/>
              <Metric label="Impermanent loss" value={`${activeIl.toFixed(2)}%`} detail={`At ${activePct > 0 ? "+" : ""}${activePct}% price move vs. holding`} color="text-rose-300"/>
              <Metric label="Concentrated position" value={`${activeConcentrated.toFixed(2)}%`} detail={`Including one quarter of estimated annual fees`} color="text-cyan-300"/>
            </section>
            <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Yield vs. price change</h2><p className="text-xs text-slate-400">Drag the amber handles to set your range; click or drag elsewhere to move the price marker.</p></div><div className="flex flex-wrap gap-4 text-xs"><span className="flex items-center gap-2 text-rose-300"><i className="h-0.5 w-4 bg-rose-400"/>Constant product IL</span><span className="flex items-center gap-2 text-cyan-300"><i className="h-0.5 w-4 bg-cyan-400"/>Concentrated + fees</span><span className="flex items-center gap-2 text-amber-300"><i className="h-0.5 w-4 bg-amber-400"/>Range boundary</span></div></div>
              <canvas ref={canvasRef} className="h-[300px] w-full touch-none cursor-crosshair" aria-label="Interactive chart of impermanent loss and concentrated liquidity return by price change" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}/>
              {(activePct <= lowerPct || activePct >= upperPct) && <p role="status" className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Price is outside your selected range. Concentrated liquidity is fully in one asset and earns no swap fees until price returns to range.</p>}
              {Math.abs(activeIl) >= 10 && <p role="status" className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">Impermanent loss is {Math.abs(activeIl).toFixed(1)}% at this price move. Loss can deepen as price diverges from the entry price.</p>}
            </section>
            <p className="px-1 text-xs leading-relaxed text-slate-500">Model notes: impermanent loss uses the exact fee-free x·y=k pool ratio formula. Fee APY annualizes assumed daily volume × configured fee × your supplied fee share; the 0.30% default matches the AMM pool’s default fee. Concentrated liquidity uses Uniswap v3 style square-root price bounds as an illustrative comparison; the Soroban contract currently implements constant product pools only. Results exclude price paths, compounding, gas, and changing volume.</p>
          </div>
        </div>
      </div>
    </main>
  );
}

function Slider({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (value: number) => void }) {
  return <label className="block text-sm"><span className="mb-2 flex justify-between gap-2 text-slate-300"><span>{label}</span><span className="font-mono text-cyan-200">{display}</span></span><input className="w-full accent-cyan-400" type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))}/><span className="sr-only">{label}: {display}</span></label>;
}

function Metric({ label, value, detail, color }: { label: string; value: string; detail: string; color: string }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4"><p className="text-xs text-slate-400">{label}</p><p className={`mt-2 text-2xl font-semibold ${color}`}>{value}</p><p className="mt-1 text-xs leading-relaxed text-slate-500">{detail}</p></div>;
}

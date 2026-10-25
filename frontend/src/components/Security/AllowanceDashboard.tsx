"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { useWallet } from "@/components/providers/WalletProvider";
import {
  getTrackedSacTokens,
  TRACKED_SACS_UPDATED_EVENT,
  TrackedSacToken,
} from "@/hooks/useAssetBalances";
import {
  AllowanceSpender,
  AllowanceToken,
  allowanceRisk,
  allowanceStatus,
  buildAllowanceUpdateTransaction,
  formatTokenAmount,
  NETWORK_RPC_URLS,
  scanTokenAllowances,
  TokenAllowance,
} from "@/lib/tokenAllowances";

const REFRESH_INTERVAL_MS = 20_000;
const WATCHLIST_KEY = "stellar_allowance_spenders_v1";
const STELLAR_ADDRESS = /^(?:G|C)[A-Z2-7]{55}$/;

type ExpirationFilter = "all" | "active" | "expiring" | "expired";

function watchlistStorageKey(account: string, network: string): string {
  return `${WATCHLIST_KEY}:${account}:${encodeURIComponent(network)}`;
}

function readSpenders(account: string, network: string): AllowanceSpender[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(watchlistStorageKey(account, network)) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (spender): spender is AllowanceSpender =>
        !!spender &&
        typeof spender === "object" &&
        typeof spender.address === "string" &&
        STELLAR_ADDRESS.test(spender.address) &&
        typeof spender.name === "string",
    );
  } catch {
    return [];
  }
}

function estimatedExpiration(ledger: number, currentLedger: number): string {
  const estimatedTime = Date.now() + (ledger - currentLedger) * 5_000;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(estimatedTime);
}

function allowanceKey(allowance: TokenAllowance): string {
  return `${allowance.token.contractId}:${allowance.spender.address}`;
}

export default function AllowanceDashboard() {
  const { address, networkPassphrase, status, signTransaction } = useWallet();
  const [trackedSacs, setTrackedSacs] = useState<TrackedSacToken[]>([]);
  const [spenders, setSpenders] = useState<AllowanceSpender[]>([]);
  const [watchlistScope, setWatchlistScope] = useState<string | null>(null);
  const [allowances, setAllowances] = useState<TokenAllowance[]>([]);
  const [currentLedger, setCurrentLedger] = useState(0);
  const [failedChecks, setFailedChecks] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyAllowance, setBusyAllowance] = useState<string | null>(null);
  const [symbolFilter, setSymbolFilter] = useState("all");
  const [spenderFilter, setSpenderFilter] = useState("");
  const [expirationFilter, setExpirationFilter] = useState<ExpirationFilter>("all");
  const [spenderName, setSpenderName] = useState("");
  const [spenderAddress, setSpenderAddress] = useState("");
  const [spenderFormError, setSpenderFormError] = useState<string | null>(null);
  const scanGeneration = useRef(0);

  useEffect(() => {
    const syncTrackedTokens = () => {
      setTrackedSacs(
        address ? getTrackedSacTokens(address, networkPassphrase) : [],
      );
    };
    const initialSync = window.setTimeout(syncTrackedTokens, 0);
    const handleTokenUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{
        account: string;
        networkPassphrase: string;
      }>).detail;
      if (
        detail?.account === address &&
        detail.networkPassphrase === networkPassphrase
      ) {
        syncTrackedTokens();
      }
    };
    window.addEventListener(TRACKED_SACS_UPDATED_EVENT, handleTokenUpdate);
    return () => {
      window.clearTimeout(initialSync);
      window.removeEventListener(TRACKED_SACS_UPDATED_EVENT, handleTokenUpdate);
    };
  }, [address, networkPassphrase]);

  useEffect(() => {
    scanGeneration.current += 1;
    const timeout = window.setTimeout(() => {
      const scope = address ? watchlistStorageKey(address, networkPassphrase) : null;
      setWatchlistScope(scope);
      setSpenders(address ? readSpenders(address, networkPassphrase) : []);
      setAllowances([]);
      setCurrentLedger(0);
      setIsScanning(false);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [address, networkPassphrase]);

  useEffect(() => {
    if (!address || watchlistScope !== watchlistStorageKey(address, networkPassphrase)) return;
    try {
      window.localStorage.setItem(
        watchlistStorageKey(address, networkPassphrase),
        JSON.stringify(spenders),
      );
    } catch {
      return;
    }
  }, [address, networkPassphrase, spenders, watchlistScope]);

  const refresh = useCallback(async () => {
    const generation = ++scanGeneration.current;
    if (!address || status !== "connected") {
      setAllowances([]);
      return;
    }
    const endpoint = NETWORK_RPC_URLS[networkPassphrase];
    if (!endpoint) {
      setScanError("No Soroban RPC endpoint is configured for the selected network.");
      return;
    }
    setIsScanning(true);
    try {
      const server = new rpc.Server(endpoint, {
        allowHttp: endpoint.startsWith("http://"),
      });
      const result = await scanTokenAllowances(
        address,
        networkPassphrase,
        trackedSacs.map((token): AllowanceToken => ({
          contractId: token.contractId,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
        })),
        spenders,
        server,
      );
      if (generation !== scanGeneration.current) return;
      setAllowances(result.allowances);
      setFailedChecks(result.failedChecks);
      setCurrentLedger(result.currentLedger);
      setScanError(null);
    } catch (cause) {
      if (generation !== scanGeneration.current) return;
      setScanError(
        cause instanceof Error ? cause.message : "Allowance scan failed.",
      );
    } finally {
      if (generation === scanGeneration.current) setIsScanning(false);
    }
  }, [address, networkPassphrase, spenders, status, trackedSacs]);

  useEffect(() => {
    if (!address || status !== "connected") return;
    const initialScan = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      window.clearTimeout(initialScan);
      window.clearInterval(interval);
    };
  }, [address, refresh, status]);

  const filteredAllowances = useMemo(
    () => allowances.filter((allowance) => {
      const expiration = allowanceStatus(allowance, currentLedger);
      return (
        (symbolFilter === "all" || allowance.token.symbol === symbolFilter) &&
        (!spenderFilter ||
          allowance.spender.address.toLowerCase().includes(spenderFilter.toLowerCase()) ||
          allowance.spender.name.toLowerCase().includes(spenderFilter.toLowerCase())) &&
        (expirationFilter === "all" || expiration === expirationFilter)
      );
    }),
    [allowances, currentLedger, expirationFilter, spenderFilter, symbolFilter],
  );

  const handleAddSpender = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedAddress = spenderAddress.trim().toUpperCase();
    const normalizedName = spenderName.trim();
    if (!STELLAR_ADDRESS.test(normalizedAddress)) {
      setSpenderFormError("Enter a valid Stellar account or contract address.");
      return;
    }
    if (!normalizedName) {
      setSpenderFormError("Enter a name for this spender.");
      return;
    }
    if (spenders.some((spender) => spender.address === normalizedAddress)) {
      setSpenderFormError("This spender is already on the watchlist.");
      return;
    }
    setSpenders((current) => [...current, { address: normalizedAddress, name: normalizedName }]);
    setSpenderName("");
    setSpenderAddress("");
    setSpenderFormError(null);
  };

  const handleAllowanceUpdate = async (
    allowance: TokenAllowance,
    nextAmount: bigint,
    expirationLedger: number,
    actionLabel: string,
  ) => {
    if (!address) return;
    const key = allowanceKey(allowance);
    setBusyAllowance(key);
    setActionMessage(null);
    try {
      const xdr = await buildAllowanceUpdateTransaction(
        address,
        networkPassphrase,
        allowance,
        nextAmount,
        expirationLedger,
      );
      const signedXdr = await signTransaction(xdr);
      if (!signedXdr) throw new Error("Wallet signing was cancelled or failed.");
      const endpoint = NETWORK_RPC_URLS[networkPassphrase];
      if (!endpoint) throw new Error("No RPC endpoint is configured for this network.");
      const server = new rpc.Server(endpoint, {
        allowHttp: endpoint.startsWith("http://"),
      });
      const transaction = await server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, networkPassphrase),
      );
      if (transaction.status !== "PENDING" && transaction.status !== "DUPLICATE") {
        throw new Error(`The network did not accept the allowance update (${transaction.status}).`);
      }
      setActionMessage(
        transaction.hash
          ? `${actionLabel} submitted: ${transaction.hash}. Allowance refreshes automatically.`
          : `${actionLabel} submitted. Allowance refreshes automatically.`,
      );
      window.setTimeout(() => void refresh(), 5_000);
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "Revocation failed.");
    } finally {
      setBusyAllowance(null);
    }
  };

  if (!address) {
    return (
      <section className="border-y border-white/10 py-10 text-center" aria-labelledby="allowance-dashboard-title">
        <ShieldCheck className="mx-auto mb-3 text-slate-500" size={28} />
        <h2 id="allowance-dashboard-title" className="text-lg font-semibold text-white">Token Allowances</h2>
        <p className="mt-2 text-sm text-slate-400">Connect a wallet to review SEP-41 token exposure.</p>
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-labelledby="allowance-dashboard-title">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
        <div>
          <h2 id="allowance-dashboard-title" className="text-xl font-semibold text-white">Token Allowances</h2>
          <p className="mt-1 text-xs text-slate-400">SEP-41 approvals for {address.slice(0, 6)}...{address.slice(-6)}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={isScanning || status !== "connected"}
          aria-label="Refresh token allowances"
          title="Refresh token allowances"
          className="p-2 text-slate-400 transition-colors hover:text-white disabled:opacity-40"
        >
          {isScanning ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400" aria-live="polite">
        <span>{trackedSacs.length} tracked token {trackedSacs.length === 1 ? "contract" : "contracts"}</span>
        <span>{spenders.length} watched spender {spenders.length === 1 ? "address" : "addresses"}</span>
        <span>{isScanning ? "Scanning..." : currentLedger ? `Ledger ${currentLedger}` : "Not scanned"}</span>
        <span>Auto-refresh: 20s</span>
      </div>

      <div className="flex gap-3 border-l-2 border-amber-400 bg-amber-400/5 px-4 py-3 text-xs text-amber-100" role="note">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" />
        <p>SEP-41 does not provide spender enumeration. Results cover tracked tokens and watched spender addresses only; unknown spenders cannot be discovered by standard Soroban RPC.</p>
      </div>

      <form onSubmit={handleAddSpender} className="grid gap-2 sm:grid-cols-[minmax(120px,0.7fr)_minmax(220px,1.5fr)_auto]">
        <label className="sr-only" htmlFor="allowance-spender-name">Spender name</label>
        <input
          id="allowance-spender-name"
          value={spenderName}
          onChange={(event) => setSpenderName(event.target.value)}
          placeholder="Spender name"
          className="min-w-0 border border-white/15 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
        />
        <label className="sr-only" htmlFor="allowance-spender-address">Spender address</label>
        <input
          id="allowance-spender-address"
          value={spenderAddress}
          onChange={(event) => setSpenderAddress(event.target.value)}
          placeholder="G... or C... spender address"
          className="min-w-0 border border-white/15 bg-slate-950 px-3 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
        />
        <button type="submit" className="inline-flex items-center justify-center gap-2 bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-200">
          <Plus size={16} /> Watch spender
        </button>
        {spenderFormError && <p className="text-xs text-rose-300 sm:col-span-3" role="alert">{spenderFormError}</p>}
      </form>

      {spenders.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-2 border-y border-white/10 py-3" aria-label="Watched spenders">
          {spenders.map((spender) => (
            <li key={spender.address} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="max-w-40 truncate text-slate-200" title={spender.name}>{spender.name}</span>
              <span className="max-w-36 truncate font-mono text-[10px] text-slate-500" title={spender.address}>{spender.address}</span>
              <button
                type="button"
                onClick={() => setSpenders((current) => current.filter((item) => item.address !== spender.address))}
                aria-label={`Remove ${spender.name} from spender watchlist`}
                title="Remove spender"
                className="p-1 text-slate-500 hover:text-rose-300"
              ><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="sr-only" htmlFor="allowance-token-filter">Filter by token</label>
        <select id="allowance-token-filter" value={symbolFilter} onChange={(event) => setSymbolFilter(event.target.value)} className="border border-white/15 bg-slate-950 px-3 py-2 text-sm text-slate-200">
          <option value="all">All tracked tokens</option>
          {Array.from(new Set(trackedSacs.map((token) => token.symbol))).map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
        </select>
        <label className="sr-only" htmlFor="allowance-spender-filter">Filter spender</label>
        <input id="allowance-spender-filter" value={spenderFilter} onChange={(event) => setSpenderFilter(event.target.value)} placeholder="Filter spender name or address" className="min-w-0 border border-white/15 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500" />
        <label className="sr-only" htmlFor="allowance-expiration-filter">Filter expiration</label>
        <select id="allowance-expiration-filter" value={expirationFilter} onChange={(event) => setExpirationFilter(event.target.value as ExpirationFilter)} className="border border-white/15 bg-slate-950 px-3 py-2 text-sm text-slate-200">
          <option value="all">All expiration statuses</option>
          <option value="active">Active</option>
          <option value="expiring">Expiring soon</option>
          <option value="expired">Expired</option>
        </select>
      </div>

      {scanError && <p className="text-sm text-rose-300" role="alert">{scanError}</p>}
      {failedChecks > 0 && <p className="text-xs text-amber-200" role="status">{failedChecks} allowance check(s) failed. The results may be incomplete; verify the token contract and network.</p>}
      {actionMessage && <p className="break-all text-xs text-cyan-100" role="status">{actionMessage}</p>}

      <div className="overflow-x-auto border-y border-white/10">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="py-3 pr-4 font-semibold">Token</th>
              <th className="py-3 pr-4 font-semibold">Spender</th>
              <th className="py-3 pr-4 text-right font-semibold">Allowance</th>
              <th className="py-3 pr-4 font-semibold">Expiration</th>
              <th className="py-3 pr-3 font-semibold">Risk</th>
              <th className="py-3 text-right" aria-label="Actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filteredAllowances.map((allowance) => {
              const key = allowanceKey(allowance);
              const risk = allowanceRisk(allowance);
              const expiration = allowanceStatus(allowance, currentLedger);
              return (
                <tr key={key} className="align-top">
                  <td className="py-3 pr-4">
                    <span className="font-semibold text-white">{allowance.token.symbol}</span>
                    <span className="mt-1 block max-w-48 truncate font-mono text-[10px] text-slate-500" title={allowance.token.contractId}>{allowance.token.contractId}</span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="text-slate-200">{allowance.spender.name}</span>
                    <span className="mt-1 block max-w-52 truncate font-mono text-[10px] text-slate-500" title={allowance.spender.address}>{allowance.spender.address}</span>
                  </td>
                  <td className="py-3 pr-4 text-right font-mono tabular-nums text-slate-100">{formatTokenAmount(allowance.amount, allowance.token.decimals)} {allowance.token.symbol}</td>
                  <td className="py-3 pr-4 text-xs">
                    <span className={expiration === "expired" ? "text-slate-500" : expiration === "expiring" ? "text-amber-200" : "text-slate-300"}>
                      {expiration === "expired" ? "Expired" : `Est. ${estimatedExpiration(allowance.expirationLedger, currentLedger)}`}
                    </span>
                    <span className="mt-1 block text-[10px] text-slate-500">Ledger {allowance.expirationLedger}</span>
                  </td>
                  <td className="py-3 pr-3">
                    <span className={`inline-flex whitespace-nowrap border px-2 py-1 text-[10px] font-bold uppercase ${risk === "unlimited" ? "border-rose-400/50 bg-rose-400/10 text-rose-200" : risk === "high" ? "border-amber-300/40 bg-amber-300/10 text-amber-100" : "border-emerald-300/30 bg-emerald-300/5 text-emerald-200"}`}>
                      {risk === "unlimited" ? "Unlimited" : risk === "high" ? "High exposure" : "Standard"}
                    </span>
                  </td>
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void handleAllowanceUpdate(
                          allowance,
                          allowance.amount / 2n,
                          allowance.expirationLedger,
                          "50% reduction",
                        )}
                        disabled={busyAllowance !== null || expiration === "expired" || status !== "connected"}
                        className="whitespace-nowrap border border-amber-300/40 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Reduce 50%
                      </button>
                    <button
                      type="button"
                      onClick={() => void handleAllowanceUpdate(allowance, 0n, 0, "Revocation")}
                      disabled={busyAllowance !== null || expiration === "expired" || status !== "connected"}
                      className="whitespace-nowrap border border-rose-300/40 px-3 py-2 text-xs font-semibold text-rose-100 hover:bg-rose-300/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busyAllowance === key ? <Loader2 size={14} className="inline animate-spin" /> : "Revoke"}
                    </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!filteredAllowances.length && (
              <tr><td colSpan={6} className="py-8 text-center text-sm text-slate-500">
                {isScanning ? "Checking tracked tokens and watched spenders..." : trackedSacs.length === 0 ? "No tracked token contracts. Add SACs in Asset Balances to include them here." : spenders.length === 0 ? "Add spender addresses to check their token allowances." : "No matching allowances found."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
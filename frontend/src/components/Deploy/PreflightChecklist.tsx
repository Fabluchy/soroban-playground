"use client";

import { useEffect, useRef, useState } from "react";

export interface DeploymentPlan {
  wasmPath: string;
  network: "local" | "testnet" | "futurenet" | "mainnet";
  sourceAccount: string;
  preflight: {
    salt: string;
    expectedWasmHash: string;
    mainnetConfirmed: boolean;
  };
  checkedAt: number;
}
interface Report {
  ready: boolean;
  sourceAccount: string;
  deployer: string;
  contractId: string;
  wasmHash: string;
  codeStatus: string;
  checkedAt: number;
  elapsedMs: number;
  funding: {
    reserveStroops: string;
    availableStroops: string;
    feeStroops: string;
  };
  checks: { id: string; label: string; passed: boolean }[];
  warnings: string[];
}
const NETWORKS = {
  local: "Localhost Quickstart",
  testnet: "Testnet",
  futurenet: "Futurenet",
  mainnet: "Mainnet",
} as const;
function xlm(value: string) {
  const amount = BigInt(value);
  const abs = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}${abs / 10000000n}.${String(abs % 10000000n).padStart(7, "0")} XLM`;
}

export function PreflightChecklist({
  apiBaseUrl,
  wasmPath,
  enabled,
  onPlanChange,
}: {
  apiBaseUrl: string;
  wasmPath: string;
  enabled: boolean;
  onPlanChange: (plan: DeploymentPlan | null) => void;
}) {
  const [network, setNetwork] = useState<DeploymentPlan["network"]>("testnet");
  const [salt, setSalt] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const invalidate = () => {
    ++generation.current;
    pending.current?.abort();
    setReport(null);
    setConfirmed(false);
    setBusy(false);
    onPlanChange(null);
  };
  useEffect(() => {
    ++generation.current;
    pending.current?.abort();
    setReport(null);
    setConfirmed(false);
    setBusy(false);
    onPlanChange(null);
    return () => {
      ++generation.current;
      pending.current?.abort();
    };
  }, [wasmPath, enabled, onPlanChange]);
  useEffect(() => {
    if (!report?.ready || !enabled || (network === "mainnet" && !confirmed)) {
      onPlanChange(null);
      return;
    }
    const remaining = report.checkedAt + 30000 - Date.now();
    if (remaining <= 0) {
      onPlanChange(null);
      setError("Pre-flight expired. Run checks again.");
      return;
    }
    onPlanChange({
      wasmPath,
      network,
      sourceAccount: report.sourceAccount,
      preflight: {
        salt,
        expectedWasmHash: report.wasmHash,
        mainnetConfirmed: confirmed,
      },
      checkedAt: report.checkedAt,
    });
    const timer = setTimeout(() => {
      onPlanChange(null);
      setReport(null);
      setError("Pre-flight expired. Run checks again.");
    }, remaining);
    return () => clearTimeout(timer);
  }, [report, enabled, confirmed, network, wasmPath, salt, onPlanChange]);

  const check = async () => {
    invalidate();
    setError("");
    if (!/^[a-fA-F0-9]{64}$/.test(salt)) {
      setError("Salt must contain exactly 64 hexadecimal characters.");
      return;
    }
    setBusy(true);
    const attempt = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    try {
      const response = await fetch(`${apiBaseUrl}/api/deploy/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          wasmPath,
          contractName: "hello_contract",
          network,
          preflight: { salt },
        }),
      });
      const result = await response.json();
      if (attempt !== generation.current) return;
      if (!response.ok)
        throw new Error(
          typeof result.message === "string"
            ? result.message
            : "Pre-flight failed. Check the server deployment identity and network availability.",
        );
      setReport(result);
    } catch (reason) {
      if (attempt === generation.current && !controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Network verification failed.",
        );
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Deployment pre-flight checklist"
      className="space-y-3 rounded border border-slate-600 p-3 text-sm"
    >
      <label className="block">
        Deployment network{" "}
        <select
          value={network}
          onChange={(e) => {
            invalidate();
            setNetwork(e.target.value as DeploymentPlan["network"]);
          }}
          className="block w-full bg-slate-900 p-2"
        >
          {Object.entries(NETWORKS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {network === "mainnet" && (
        <p
          role="alert"
          className="rounded border-2 border-rose-400 p-2 font-bold text-rose-200"
        >
          MAINNET — this deployment spends real XLM. Verify the deployer, code
          hash, predicted address and fee estimate before confirming.
        </p>
      )}
      <label className="block">
        Deployment salt (32 bytes, hex){" "}
        <input
          value={salt}
          maxLength={64}
          spellCheck={false}
          onChange={(e) => {
            invalidate();
            setSalt(e.target.value);
          }}
          className="block w-full bg-slate-900 p-2 font-mono"
        />
      </label>
      <button
        type="button"
        onClick={() => {
          invalidate();
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          setSalt(
            Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
          );
        }}
      >
        Generate salt
      </button>
      <button
        type="button"
        disabled={!enabled || busy}
        onClick={() => void check()}
      >
        {busy ? "Checking deployment…" : "Run pre-flight checks"}
      </button>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <ul aria-label="Pre-flight results">
            {report.checks.map((item) => (
              <li key={item.id}>
                {item.passed ? "Pass" : "Blocked"}: {item.label}
              </li>
            ))}
          </ul>
          <dl className="break-all">
            <dt>Deployer</dt>
            <dd>{report.deployer}</dd>
            <dt>WASM SHA-256</dt>
            <dd>{report.wasmHash}</dd>
            <dt>WASM status</dt>
            <dd>{report.codeStatus}</dd>
            <dt>Predicted contract address</dt>
            <dd>{report.contractId}</dd>
            <dt>Minimum account reserve</dt>
            <dd>{xlm(report.funding.reserveStroops)}</dd>
            <dt>Spendable XLM after reserve and liabilities</dt>
            <dd>{xlm(report.funding.availableStroops)}</dd>
            <dt>Estimated fee budget (not a quote)</dt>
            <dd>{xlm(report.funding.feeStroops)}</dd>
          </dl>
          {report.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <p role="status">
            {report.ready ? "Checks passed" : "Deployment blocked"} ·{" "}
            {report.elapsedMs}ms. Results expire after 30 seconds; the server
            checks again before broadcast.
          </p>
          {network === "mainnet" && report.ready && (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I confirm deployment to Mainnet using real XLM.
            </label>
          )}
        </>
      )}
    </section>
  );
}

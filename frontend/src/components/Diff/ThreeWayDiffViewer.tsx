"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronUp,
  CloudDownload,
  Columns2,
  FileCode2,
  GitCompare,
  GitMerge,
  RefreshCw,
  RotateCcw,
  Rows3,
  X,
} from "lucide-react";
import {
  applyVerifiedChunk,
  chunkSummary,
  computeLineDiff,
  mergeVerifiedChunks,
  revertLocalChunk,
  type DiffChunk,
} from "@/utils/threeWayDiff";

export interface VerifiedSourceFile {
  path: string;
  content: string;
}

export interface VerifiedContractSource {
  sourceCode: string;
  files: VerifiedSourceFile[];
  network?: string;
  status?: string;
  verified?: boolean;
  sourceHash?: string;
  verifiedAt?: string | null;
}

export interface ThreeWayDiffViewerProps {
  contractId?: string;
  apiBaseUrl?: string;
  localCode: string;
  mainCode: string;
  verifiedCode?: string;
  language?: string;
  height?: string;
  onLocalCodeChange?: (nextCode: string) => void;
  fetchVerifiedSource?: (contractId: string) => Promise<VerifiedContractSource>;
  onClose?: () => void;
}

type DiffMode = "split" | "inline";
type DiffSide = "local" | "verified";

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function normalizeFiles(data: Record<string, unknown>): VerifiedSourceFile[] {
  const rawFiles = data.files;

  if (Array.isArray(rawFiles)) {
    return rawFiles
      .map((file, index) => {
        if (typeof file === "string") {
          return { path: `src/file-${index + 1}.rs`, content: file };
        }
        if (!file || typeof file !== "object") return null;
        const record = file as Record<string, unknown>;
        const content = readString(record.content) ?? readString(record.code);
        if (!content) return null;
        return {
          path:
            readString(record.path) ??
            readString(record.name) ??
            `src/file-${index + 1}.rs`,
          content,
        };
      })
      .filter((file): file is VerifiedSourceFile => Boolean(file));
  }

  if (rawFiles && typeof rawFiles === "object") {
    return Object.entries(rawFiles as Record<string, unknown>)
      .map(([path, content]) =>
        typeof content === "string" ? { path, content } : null,
      )
      .filter((file): file is VerifiedSourceFile => Boolean(file));
  }

  const sourceCode =
    readString(data.sourceCode) ??
    readString(data.code) ??
    readString(
      (data.metadata as Record<string, unknown> | undefined)?.sourceCode,
    );

  if (sourceCode) {
    return [
      {
        path:
          readString(data.path) ?? readString(data.filePath) ?? "src/lib.rs",
        content: sourceCode,
      },
    ];
  }

  return [];
}

export async function fetchVerifiedContractSource(
  contractId: string,
  apiBaseUrl = "",
): Promise<VerifiedContractSource> {
  const baseUrl = apiBaseUrl.replace(/\/$/, "");
  const encodedId = encodeURIComponent(contractId);
  const endpoints = [
    `${baseUrl}/api/verify/contracts/${encodedId}/source`,
    `${baseUrl}/api/verify/contracts/${encodedId}`,
  ];

  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        lastError = new Error(
          `Verification registry returned HTTP ${response.status}`,
        );
        continue;
      }

      const payload = await response.json();
      const data = (payload?.data ?? payload) as Record<string, unknown>;
      const files = normalizeFiles(data);

      if (files.length === 0) {
        lastError = new Error("Verified source code was not found");
        continue;
      }

      return {
        sourceCode: files[0].content,
        files,
        network: readString(data.network),
        status: readString(data.status),
        verified:
          typeof data.verified === "boolean"
            ? data.verified
            : data.status === "verified",
        sourceHash: readString(data.sourceHash),
        verifiedAt:
          readString(data.verifiedAt) ??
          (data.verifiedAt === null ? null : undefined),
      };
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Unable to reach the verification registry");
    }
  }

  throw lastError ?? new Error("Unable to load verified contract source");
}

const diffOptionsBase = {
  readOnly: true,
  originalEditable: false,
  fontSize: 12,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderOverviewRuler: true,
  renderIndicators: true,
  enableSplitViewResizing: true,
  automaticLayout: true,
  wordWrap: "off" as const,
  diffWordWrap: "off" as const,
  maxComputationTime: 5000,
};

export default function ThreeWayDiffViewer({
  contractId,
  apiBaseUrl = "",
  localCode,
  mainCode,
  verifiedCode,
  language = "rust",
  height = "520px",
  onLocalCodeChange,
  fetchVerifiedSource,
  onClose,
}: ThreeWayDiffViewerProps) {
  const [mode, setMode] = useState<DiffMode>("split");
  const [activeSide, setActiveSide] = useState<DiffSide>("local");
  const [activeChunkIndex, setActiveChunkIndex] = useState(0);
  const [verifiedSource, setVerifiedSource] =
    useState<VerifiedContractSource | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    if (verifiedCode !== undefined) {
      setVerifiedSource({
        sourceCode: verifiedCode,
        files: [{ path: "src/lib.rs", content: verifiedCode }],
        verified: true,
      });
      setSelectedFilePath("src/lib.rs");
      setLoadError(null);
      return;
    }

    if (!contractId) {
      setVerifiedSource(null);
      setSelectedFilePath(null);
      return;
    }

    let cancelled = false;
    const load = fetchVerifiedSource
      ? fetchVerifiedSource(contractId)
      : fetchVerifiedContractSource(contractId, apiBaseUrl);

    setIsLoading(true);
    setLoadError(null);

    load
      .then((source) => {
        if (cancelled) return;
        setVerifiedSource(source);
        setSelectedFilePath(source.files[0]?.path ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setVerifiedSource(null);
        setSelectedFilePath(null);
        setLoadError(
          error instanceof Error
            ? error.message
            : "Unable to load verified contract source",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, contractId, fetchVerifiedSource, reloadNonce, verifiedCode]);

  const selectedVerifiedFile = useMemo(
    () =>
      verifiedSource?.files.find((file) => file.path === selectedFilePath) ??
      verifiedSource?.files[0],
    [selectedFilePath, verifiedSource],
  );

  const verifiedCodeValue = verifiedCode ?? selectedVerifiedFile?.content ?? "";
  const localDiff = useMemo(
    () => computeLineDiff(mainCode, localCode),
    [localCode, mainCode],
  );
  const verifiedDiff = useMemo(
    () => computeLineDiff(mainCode, verifiedCodeValue),
    [mainCode, verifiedCodeValue],
  );
  const activeChunks =
    activeSide === "local" ? localDiff.chunks : verifiedDiff.chunks;

  useEffect(() => {
    setActiveChunkIndex(0);
    setActionMessage(null);
  }, [activeSide, activeChunks.length]);

  const revealChunk = useCallback((chunk: DiffChunk | undefined) => {
    if (!chunk) return;
    const line = chunk.start + 1;
    const modifiedEditor = diffEditorRef.current?.getModifiedEditor();
    const originalEditor = diffEditorRef.current?.getOriginalEditor();
    modifiedEditor?.revealLineInCenter(line);
    originalEditor?.revealLineInCenter(line);
    modifiedEditor?.setPosition({ lineNumber: line, column: 1 });
  }, []);

  const navigateChunks = useCallback(
    (direction: number) => {
      if (activeChunks.length === 0) return;
      const nextIndex =
        (activeChunkIndex + direction + activeChunks.length) %
        activeChunks.length;
      setActiveChunkIndex(nextIndex);
      revealChunk(activeChunks[nextIndex]);
    },
    [activeChunkIndex, activeChunks, revealChunk],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F7") return;
      event.preventDefault();
      navigateChunks(event.shiftKey ? -1 : 1);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateChunks]);

  const handleCherryPick = (chunk: DiffChunk) => {
    if (!onLocalCodeChange) return;

    const result =
      activeSide === "verified"
        ? applyVerifiedChunk(mainCode, localCode, verifiedCodeValue, chunk)
        : revertLocalChunk(mainCode, localCode, chunk);

    if (!result.ok) {
      setActionMessage(
        result.reason === "conflict"
          ? "This chunk overlaps local edits and cannot be applied automatically."
          : "This chunk no longer exists in the current diff.",
      );
      return;
    }

    onLocalCodeChange(result.code);
    setActionMessage(
      activeSide === "verified"
        ? "On-chain chunk cherry-picked into the working buffer."
        : "Local chunk reverted to the repository baseline.",
    );
  };

  const handleMergeVerified = () => {
    if (!onLocalCodeChange || !verifiedCodeValue) return;
    const merged = mergeVerifiedChunks(mainCode, localCode, verifiedCodeValue);
    onLocalCodeChange(merged.code);
    setActionMessage(
      merged.conflicts > 0
        ? `Applied ${merged.applied} on-chain chunk(s); ${merged.conflicts} conflicted and were skipped.`
        : `Applied all ${merged.applied} on-chain chunk(s).`,
    );
  };

  const diffOptions = useMemo(
    () => ({
      ...diffOptionsBase,
      renderSideBySide: mode === "split",
    }),
    [mode],
  );

  const windowStart = Math.max(
    0,
    Math.min(activeChunkIndex - 20, Math.max(0, activeChunks.length - 40)),
  );
  const visibleChunks = activeChunks.slice(windowStart, windowStart + 40);
  const activeChunk = activeChunks[activeChunkIndex];
  const verifiedLabel =
    verifiedSource?.network || verifiedSource?.status || "on-chain";

  return (
    <section className="flex h-full min-h-[560px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 text-slate-100 shadow-2xl">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">
            <GitCompare size={16} />
            Three-way semantic diff
          </h2>
          <p className="mt-1 font-mono text-xs text-slate-500">
            {contractId || "Local workspace"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setMode("split")}
            aria-pressed={mode === "split"}
            className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs ${
              mode === "split"
                ? "border-teal-400/40 bg-teal-400/10 text-teal-100"
                : "border-white/10 text-slate-300 hover:bg-white/5"
            }`}
          >
            <Columns2 size={14} />
            Split
          </button>
          <button
            type="button"
            onClick={() => setMode("inline")}
            aria-pressed={mode === "inline"}
            className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs ${
              mode === "inline"
                ? "border-teal-400/40 bg-teal-400/10 text-teal-100"
                : "border-white/10 text-slate-300 hover:bg-white/5"
            }`}
          >
            <Rows3 size={14} />
            Unified
          </button>
          {onClose && (
            <button
              type="button"
              aria-label="Close semantic diff viewer"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="grid gap-2 border-b border-white/10 px-4 py-3 text-xs sm:grid-cols-3">
        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Working buffer
          </p>
          <p className="mt-1 text-slate-200">
            {localDiff.modifiedLineCount} lines
          </p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Main baseline
          </p>
          <p className="mt-1 text-slate-200">{localDiff.baseLineCount} lines</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Verified {verifiedLabel}
          </p>
          <p className="mt-1 text-slate-200">
            {isLoading
              ? "Loading..."
              : `${verifiedDiff.modifiedLineCount} lines`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveSide("local")}
            aria-pressed={activeSide === "local"}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs ${
              activeSide === "local"
                ? "bg-white/10 text-white"
                : "text-slate-400 hover:bg-white/5"
            }`}
          >
            <ArrowLeftRight size={13} />
            Local vs main
          </button>
          <button
            type="button"
            onClick={() => setActiveSide("verified")}
            aria-pressed={activeSide === "verified"}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs ${
              activeSide === "verified"
                ? "bg-white/10 text-white"
                : "text-slate-400 hover:bg-white/5"
            }`}
          >
            <CloudDownload size={13} />
            On-chain vs main
          </button>
          {verifiedSource && verifiedSource.files.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <FileCode2 size={13} />
              <select
                aria-label="Verified source file"
                value={selectedFilePath ?? ""}
                onChange={(event) => setSelectedFilePath(event.target.value)}
                className="rounded border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-200"
              >
                {verifiedSource.files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">
            {activeChunks.length === 0
              ? "No changes"
              : `Chunk ${activeChunkIndex + 1} of ${activeChunks.length}`}
          </span>
          <button
            type="button"
            aria-label="Previous diff chunk"
            onClick={() => navigateChunks(-1)}
            disabled={activeChunks.length === 0}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-40"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            aria-label="Next diff chunk"
            onClick={() => navigateChunks(1)}
            disabled={activeChunks.length === 0}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-40"
          >
            <ChevronDown size={14} />
          </button>
          <span className="hidden text-[10px] uppercase tracking-[0.16em] text-slate-600 sm:inline">
            F7 / Shift+F7
          </span>
          <button
            type="button"
            onClick={handleMergeVerified}
            disabled={!onLocalCodeChange || !verifiedCodeValue}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-teal-400/30 bg-teal-400/10 px-2.5 text-xs text-teal-100 hover:bg-teal-400/15 disabled:opacity-40"
          >
            <GitMerge size={13} />
            Merge on-chain
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setReloadNonce((value) => value + 1)}
            className="inline-flex items-center gap-1 text-rose-100 hover:text-white"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      )}

      {actionMessage && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <Check size={13} />
          {actionMessage}
        </div>
      )}

      <div className="min-h-0 flex-1 p-4">
        <div className="h-full overflow-hidden rounded-xl border border-white/10 bg-[#1e1e1e]">
          <DiffEditor
            height={height}
            language={language}
            original={mainCode}
            modified={activeSide === "local" ? localCode : verifiedCodeValue}
            theme="vs-dark"
            options={diffOptions}
            onMount={(instance) => {
              diffEditorRef.current = instance;
            }}
          />
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto border-t border-white/10 px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-slate-500">
          <span>Diff chunks</span>
          {activeChunks.length > visibleChunks.length && (
            <span>
              Showing {windowStart + 1}-{windowStart + visibleChunks.length} of{" "}
              {activeChunks.length}
            </span>
          )}
        </div>

        {activeChunks.length === 0 ? (
          <p className="text-xs text-slate-500">
            No differences between this buffer and the selected baseline.
          </p>
        ) : (
          <div className="space-y-1.5">
            {visibleChunks.map((chunk, index) => {
              const chunkIndex = windowStart + index;
              const isActive = chunkIndex === activeChunkIndex;
              return (
                <div
                  key={chunk.id}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                    isActive
                      ? "border-teal-400/40 bg-teal-400/10"
                      : "border-white/10 bg-white/[0.03]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveChunkIndex(chunkIndex);
                      revealChunk(chunk);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-400">
                      {chunk.kind}
                    </span>
                    <span className="truncate font-mono text-slate-300">
                      {chunk.header}
                    </span>
                    <span className="shrink-0 text-slate-500">
                      {chunkSummary(chunk)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCherryPick(chunk)}
                    disabled={!onLocalCodeChange}
                    className="inline-flex min-h-7 items-center gap-1 rounded border border-white/15 px-2 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-40"
                  >
                    {activeSide === "verified" ? (
                      <CloudDownload size={11} />
                    ) : (
                      <RotateCcw size={11} />
                    )}
                    {activeSide === "verified" ? "Cherry-pick" : "Revert"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

"use client";

/**
 * ConflictEditor – the three-way split merge conflict editor
 * (issue #1727 / FE-27).
 *
 * Every conflicting region of a file is rendered as a card with three panes:
 * the *current* side (`HEAD`), the *base* (common ancestor, when the file
 * carries `diff3` style markers) and the *incoming* side. The user resolves a
 * region with "Accept Current", "Accept Incoming" or "Combine".
 *
 * The resolved output is produced by
 * {@link applyResolutions}, which keeps the line placement of the untouched
 * parts of the file intact.
 */

import React, { useMemo } from "react";
import { AlertTriangle, Check, GitMerge } from "lucide-react";
import {
  applyResolutions,
  parseConflictHunks,
  resolveConflictHunk,
} from "@/lib/git/conflicts";
import type { ConflictHunk, ConflictResolution } from "@/lib/git/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConflictEditorProps {
  /** Path of the conflicted file. */
  path: string;
  /** File content that carries the conflict markers. */
  content: string;
  /** Resolutions already chosen by the user, keyed by hunk id. */
  resolutions?: Record<string, ConflictResolution>;
  /** Manually edited text per hunk id, used by the "Combine" resolution. */
  combinedTexts?: Record<string, string>;
  /** Fired whenever the resolution of a hunk changes. */
  onResolutionChange?: (hunkId: string, resolution: ConflictResolution) => void;
  /** Fired whenever the manually combined text of a hunk changes. */
  onCombinedTextChange?: (hunkId: string, text: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a list of source lines as a monospace block. */
function LineBlock({
  lines,
  tone,
  testId,
}: {
  lines: string[];
  tone: "current" | "base" | "incoming";
  testId: string;
}) {
  const toneClass =
    tone === "current"
      ? "text-teal-200"
      : tone === "incoming"
        ? "text-amber-200"
        : "text-slate-400";

  return (
    <pre
      data-testid={testId}
      className={[
        "min-h-[3rem] overflow-x-auto whitespace-pre-wrap rounded-lg border border-white/8 bg-slate-950/70 p-2 font-mono text-[11px] leading-5",
        toneClass,
      ].join(" ")}
    >
      {lines.length === 0 ? (
        <span className="text-slate-600">— no lines —</span>
      ) : (
        lines.map((line, index) => (
          <span key={`${index}-${line}`} className="block">
            {line.length === 0 ? " " : line}
          </span>
        ))
      )}
    </pre>
  );
}

/** A resolution button. */
function ResolutionButton({
  active,
  label,
  testId,
  onClick,
}: {
  active: boolean;
  label: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition",
        active
          ? "border-teal-400/60 bg-teal-400/15 text-teal-200"
          : "border-white/10 bg-white/5 text-slate-300 hover:border-teal-400/40 hover:text-teal-200",
      ].join(" ")}
    >
      {active ? <Check size={12} /> : null}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ConflictCard – one conflicting region
// ---------------------------------------------------------------------------

interface ConflictCardProps {
  hunk: ConflictHunk;
  index: number;
  total: number;
  resolution: ConflictResolution | undefined;
  combinedText: string | undefined;
  onResolutionChange: (resolution: ConflictResolution) => void;
  onCombinedTextChange: (text: string) => void;
}
function ConflictCard({
  hunk,
  index,
  total,
  resolution,
  combinedText,
  onResolutionChange,
  onCombinedTextChange,
}: ConflictCardProps) {
  const isCombine = resolution === "combined";
  const combinedPreview = useMemo(
    () =>
      resolveConflictHunk(hunk, "combined", {
        ...(typeof combinedText === "string"
          ? { combinedText }
          : {}),
      }).join("\n"),
    [hunk, combinedText],
  );

  return (
    <article
      data-testid="conflict-hunk"
      data-hunk-id={hunk.id}
      className="rounded-xl border border-amber-400/25 bg-amber-400/[0.04] p-3"
    >
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold text-amber-200">
          <AlertTriangle size={13} />
          Conflict {index + 1} of {total}
          <span className="font-mono text-[10px] text-slate-500">
            lines {hunk.startLine + 1}–{hunk.endLine + 1}
          </span>
        </p>
        {resolution ? (
          <span
            data-testid="conflict-resolved-badge"
            className="rounded-full bg-teal-400/15 px-2 py-0.5 text-[10px] font-medium text-teal-200"
          >
            {resolution === "current"
              ? "Current accepted"
              : resolution === "incoming"
                ? "Incoming accepted"
                : "Combined"}
          </span>
        ) : (
          <span className="text-[10px] text-amber-300/80">Unresolved</span>
        )}
      </header>

      <div className="grid gap-2 md:grid-cols-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-teal-300/80">
            Current · {hunk.currentLabel || "HEAD"}
          </p>
          <LineBlock
            lines={hunk.currentLines}
            tone="current"
            testId={`${hunk.id}-current`}
          />
        </div>

        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Base · ancestor
          </p>
          <LineBlock
            lines={hunk.baseLines ?? []}
            tone="base"
            testId={`${hunk.id}-base`}
          />
        </div>

        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
            Incoming · {hunk.incomingLabel || "theirs"}
          </p>
          <LineBlock
            lines={hunk.incomingLines}
            tone="incoming"
            testId={`${hunk.id}-incoming`}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ResolutionButton
          active={resolution === "current"}
          label="Accept Current"
          testId={`${hunk.id}-accept-current`}
          onClick={() => onResolutionChange("current")}
        />
        <ResolutionButton
          active={resolution === "incoming"}
          label="Accept Incoming"
          testId={`${hunk.id}-accept-incoming`}
          onClick={() => onResolutionChange("incoming")}
        />
        <ResolutionButton
          active={resolution === "combined"}
          label="Combine"
          testId={`${hunk.id}-accept-combined`}
          onClick={() => onResolutionChange("combined")}
        />
      </div>

      {isCombine && (
        <div className="mt-3">
          <label
            htmlFor={`${hunk.id}-combined-input`}
            className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400"
          >
            Combined result
          </label>
          <textarea
            id={`${hunk.id}-combined-input`}
            data-testid={`${hunk.id}-combined-input`}
            value={combinedText ?? combinedPreview}
            onChange={(event) => onCombinedTextChange(event.target.value)}
            className="h-24 w-full rounded-lg border border-white/10 bg-slate-950/70 p-2 font-mono text-[11px] leading-5 text-slate-200 outline-none focus:border-teal-400/50"
          />
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// ConflictEditor
// ---------------------------------------------------------------------------

const ConflictEditor: React.FC<ConflictEditorProps> = ({
  path,
  content,
  resolutions = {},
  combinedTexts = {},
  onResolutionChange,
  onCombinedTextChange,
}) => {
  const hunks = useMemo(() => parseConflictHunks(content), [content]);

  const resolvedPreview = useMemo(
    () => applyResolutions(content, resolutions, { combinedTexts }),
    [content, resolutions, combinedTexts],
  );

  if (hunks.length === 0) {
    return (
      <p
        data-testid="conflict-editor-empty"
        className="rounded-xl border border-white/8 bg-slate-950/50 px-3 py-4 text-xs text-slate-400"
      >
        No conflicts detected in <span className="font-mono">{path}</span>.
      </p>
    );
  }

  return (
    <section
      data-testid="conflict-editor"
      data-path={path}
      className="space-y-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.03] p-3"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-amber-200">
          <GitMerge size={14} />
          Resolve conflicts · <span className="font-mono">{path}</span>
        </p>
        <span className="text-[10px] text-slate-400">
          {hunks.length} conflicting region{hunks.length === 1 ? "" : "s"}
        </span>
      </header>

      {hunks.map((hunk, index) => (
        <ConflictCard
          key={hunk.id}
          hunk={hunk}
          index={index}
          total={hunks.length}
          resolution={resolutions[hunk.id]}
          combinedText={combinedTexts[hunk.id]}
          onResolutionChange={(resolution) =>
            onResolutionChange?.(hunk.id, resolution)
          }
          onCombinedTextChange={(text) =>
            onCombinedTextChange?.(hunk.id, text)
          }
        />
      ))}

      <details className="rounded-xl border border-white/8 bg-slate-950/50 p-3">
        <summary className="cursor-pointer text-[11px] font-medium text-slate-300">
          Resolved preview
        </summary>
        <pre
          data-testid="conflict-editor-preview"
          className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950/80 p-2 font-mono text-[11px] leading-5 text-slate-200"
        >
          {resolvedPreview}
        </pre>
      </details>
    </section>
  );
};

export default ConflictEditor;

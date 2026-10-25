// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Three-way merge (diff3) for the in-app Git engine (issue #1727 / FE-27).
 *
 * The merge takes the common ancestor (`base`), the *current* side and the
 * *incoming* side and produces either a clean result or a file containing
 * Git-style conflict markers.
 *
 * The resulting conflict markers are re-parsed with
 * {@link parseConflictHunks} so the reported line numbers always match the
 * produced content exactly — the three-way editor relies on that to place the
 * resolved lines correctly.
 */

import { joinLines, parseConflictHunks, splitLines } from "./conflicts";
import { applyEdits, diffToEdits, type Edit } from "./diff";
import type { ConflictHunk } from "./types";

/** Conflict marker prefixes used when writing the merged content. */
const CONFLICT_START = "<<<<<<<";
const CONFLICT_SEPARATOR = "=======";
const CONFLICT_END = ">>>>>>>";

/** Result of a three-way merge of a single file. */
export interface ThreeWayMergeResult {
  /** `clean` when both sides could be combined automatically. */
  status: "clean" | "conflict";
  /** The merged content — with conflict markers when `status === "conflict"`. */
  content: string;
  /** Conflicting regions, with accurate line placement. */
  conflicts: ConflictHunk[];
}

/** Options for {@link threeWayMerge}. */
export interface ThreeWayMergeOptions {
  /** Label used for the current side in the conflict markers. */
  currentLabel?: string;
  /** Label used for the incoming side in the conflict markers. */
  incomingLabel?: string;
}

/** `true` when the two edit ranges touch each other. */
function rangesConflict(a: Edit, b: Edit): boolean {
  const aInsertion = a.baseStart === a.baseEnd;
  const bInsertion = b.baseStart === b.baseEnd;

  if (aInsertion && bInsertion) return a.baseStart === b.baseStart;
  if (aInsertion) return b.baseStart <= a.baseStart && a.baseStart <= b.baseEnd;
  if (bInsertion) return a.baseStart <= b.baseStart && b.baseStart <= a.baseEnd;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

/** `true` when both edit lists carry the very same replacement. */
function sameEdit(a: Edit, b: Edit): boolean {
  if (a.baseStart !== b.baseStart || a.baseEnd !== b.baseEnd) return false;
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, index) => line === b.lines[index]);
}

/**
 * Produce the side content for the base range `[start, end)`.
 *
 * `edits` are the replacements of one side; only the ones fully inside the
 * range are applied.
 */
function sideContent(
  base: string[],
  edits: Edit[],
  start: number,
  end: number,
): string[] {
  const scoped = edits.filter(
    (edit) => edit.baseStart >= start && edit.baseEnd <= end,
  );
  const applied = applyEdits(base, scoped);
  const delta = scoped.reduce(
    (sum, edit) => sum + (edit.lines.length - (edit.baseEnd - edit.baseStart)),
    0,
  );
  const length = Math.max(0, end - start) + delta;
  return applied.slice(start, start + length);
}

/**
 * Merge `current` and `incoming` using `base` as the common ancestor.
 *
 * When both sides changed the same region the result contains Git conflict
 * markers and the `conflicts` array describes every region.
 */
export function threeWayMerge(
  base: string,
  current: string,
  incoming: string,
  options: ThreeWayMergeOptions = {},
): ThreeWayMergeResult {
  const currentLabel = options.currentLabel ?? "HEAD";
  const incomingLabel = options.incomingLabel ?? "incoming";

  // Fast path — one side did not change at all.
  if (current === incoming) {
    return { status: "clean", content: current, conflicts: [] };
  }
  if (base === current) {
    return { status: "clean", content: incoming, conflicts: [] };
  }
  if (base === incoming) {
    return { status: "clean", content: current, conflicts: [] };
  }

  const baseLines = splitLines(base);
  const currentLines = splitLines(current);
  const incomingLines = splitLines(incoming);

  const currentEdits = diffToEdits(baseLines, currentLines);
  const incomingEdits = diffToEdits(baseLines, incomingLines);

  const output: string[] = [];
  let baseIndex = 0;
  let currentIndex = 0;
  let incomingIndex = 0;
  let conflicted = false;

  while (
    currentIndex < currentEdits.length ||
    incomingIndex < incomingEdits.length
  ) {
    const currentEdit = currentEdits[currentIndex];
    const incomingEdit = incomingEdits[incomingIndex];

    const nextStart = Math.min(
      currentEdit ? currentEdit.baseStart : Number.POSITIVE_INFINITY,
      incomingEdit ? incomingEdit.baseStart : Number.POSITIVE_INFINITY,
    );

    // Copy the untouched base lines up to the next edit.
    while (baseIndex < nextStart) {
      output.push(baseLines[baseIndex]);
      baseIndex += 1;
    }

    if (currentEdit && incomingEdit) {
      if (sameEdit(currentEdit, incomingEdit)) {
        // Both sides made the very same change — take it once.
        output.push(...currentEdit.lines);
        baseIndex = currentEdit.baseEnd;
        currentIndex += 1;
        incomingIndex += 1;
        continue;
      }

      if (!rangesConflict(currentEdit, incomingEdit)) {
        // The edits touch different regions — apply the earlier one first.
        if (currentEdit.baseStart <= incomingEdit.baseStart) {
          output.push(...currentEdit.lines);
          baseIndex = currentEdit.baseEnd;
          currentIndex += 1;
        } else {
          output.push(...incomingEdit.lines);
          baseIndex = incomingEdit.baseEnd;
          incomingIndex += 1;
        }
        continue;
      }

      // Real conflict — emit Git style markers covering the union of both
      // edited ranges.
      const start = Math.min(currentEdit.baseStart, incomingEdit.baseStart);
      const end = Math.max(currentEdit.baseEnd, incomingEdit.baseEnd);

      const currentSide = sideContent(baseLines, currentEdits, start, end);
      const incomingSide = sideContent(baseLines, incomingEdits, start, end);

      output.push(`${CONFLICT_START} ${currentLabel}`);
      output.push(...currentSide);
      output.push(CONFLICT_SEPARATOR);
      output.push(...incomingSide);
      output.push(`${CONFLICT_END} ${incomingLabel}`);

      conflicted = true;
      baseIndex = end;
      currentIndex += 1;
      incomingIndex += 1;
      continue;
    }

    if (currentEdit) {
      output.push(...currentEdit.lines);
      baseIndex = currentEdit.baseEnd;
      currentIndex += 1;
      continue;
    }

    if (incomingEdit) {
      output.push(...incomingEdit.lines);
      baseIndex = incomingEdit.baseEnd;
      incomingIndex += 1;
    }
  }

  while (baseIndex < baseLines.length) {
    output.push(baseLines[baseIndex]);
    baseIndex += 1;
  }

  const content = joinLines(output);

  if (!conflicted) {
    return { status: "clean", content, conflicts: [] };
  }

  // Re-parse the produced content so the reported line numbers are exact.
  return {
    status: "conflict",
    content,
    conflicts: parseConflictHunks(content),
  };
}

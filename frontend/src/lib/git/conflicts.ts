// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Conflict-marker detection and resolution parsing (issue #1727 / FE-27).
 *
 * Git encodes an unresolved merge as plain text markers:
 *
 * ```text
 * <<<<<<< HEAD
 * our version
 * =======
 * their version
 * >>>>>>> feature/hello
 * ```
 *
 * The `diff3` style additionally carries the common ancestor:
 *
 * ```text
 * <<<<<<< HEAD
 * our version
 * ||||||| base
 * original version
 * =======
 * their version
 * >>>>>>> feature/hello
 * ```
 *
 * This module is intentionally free of DOM/React dependencies so the parsing
 * rules can be unit tested in isolation.
 */

import type { ConflictHunk, ConflictResolution } from "./types";

/** Marker that opens a conflict region. */
export const CONFLICT_START_MARKER = "<<<<<<<";
/** Marker that separates the current side from the incoming side. */
export const CONFLICT_SEPARATOR_MARKER = "=======";
/** Marker that closes a conflict region. */
export const CONFLICT_END_MARKER = ">>>>>>>";
/** Marker that introduces the base section of a `diff3` conflict. */
export const CONFLICT_BASE_MARKER = "|||||||";

/** Matches the opening marker, capturing the optional label. */
const START_PATTERN = /^<{7}(?:[ \t]+(.*))?$/;
/** Matches the separator marker (the current side ends here). */
const SEPARATOR_PATTERN = /^={7,}[ \t]*$/;
/** Matches the closing marker, capturing the optional label. */
const END_PATTERN = /^>{7}(?:[ \t]+(.*))?$/;
/** Matches the `diff3` base marker, capturing the optional label. */
const BASE_PATTERN = /^\|{7}(?:[ \t]+(.*))?$/;

/** A raw conflict region straight out of the file. */
export interface ConflictMarker {
  /** Zero-based line index of the `<<<<<<<` marker. */
  startLine: number;
  /** Zero-based line index of the `=======` marker (or the base marker). */
  separatorLine: number;
  /** Zero-based line index of the `>>>>>>>` marker. */
  endLine: number;
  /** Zero-based line index of the `|||||||` marker, `null` for classic style. */
  baseLine: number | null;
  /** Label written next to the opening marker. */
  currentLabel: string;
  /** Label written next to the closing marker. */
  incomingLabel: string;
  /** Lines belonging to the current side. */
  currentLines: string[];
  /** Lines belonging to the incoming side. */
  incomingLines: string[];
  /** Base lines for `diff3` style conflicts, `null` for the classic style. */
  baseLines: string[] | null;
}

/**
 * Split a blob into lines, dropping a single trailing newline.
 *
 * Git treats the file content as a list of lines; keeping the trailing
 * newline out of the array makes the round-trip through the merge engine
 * lossless.
 */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Join lines back into a blob, restoring the trailing newline. */
export function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Detect every conflict region inside `content`.
 *
 * Malformed regions (an opening marker without a closing marker, a separator
 * without an opening marker, …) are ignored rather than throwing, so the UI
 * can still display a partially broken file.
 */
export function detectConflictMarkers(content: string): ConflictMarker[] {
  const lines = splitLines(content);
  const markers: ConflictMarker[] = [];

  let index = 0;
  while (index < lines.length) {
    const startMatch = lines[index].match(START_PATTERN);
    if (!startMatch) {
      index += 1;
      continue;
    }

    const startLine = index;
    const currentLabel = (startMatch[1] ?? "").trim();

    // Collect the current side, the optional base side and the incoming side.
    const currentLines: string[] = [];
    const baseContent: string[] = [];
    const incomingLines: string[] = [];
    let separatorLine = -1;
    let endLine = -1;
    let baseLine: number | null = null;
    let incomingLabel = "";
    let cursor = startLine + 1;
    let sawSeparator = false;
    let sawBase = false;

    while (cursor < lines.length) {
      const line = lines[cursor];

      if (!sawSeparator) {
        if (SEPARATOR_PATTERN.test(line)) {
          separatorLine = cursor;
          sawSeparator = true;
          cursor += 1;
          continue;
        }
        if (BASE_PATTERN.test(line)) {
          // `diff3` style — the ancestor section follows the current side.
          sawBase = true;
          baseLine = cursor;
          cursor += 1;
          continue;
        }
        if (sawBase) baseContent.push(line);
        else currentLines.push(line);
        cursor += 1;
        continue;
      }

      const endMatch = line.match(END_PATTERN);
      if (endMatch) {
        endLine = cursor;
        incomingLabel = (endMatch[1] ?? "").trim();
        cursor += 1;
        break;
      }

      incomingLines.push(line);
      cursor += 1;
    }

    if (!sawSeparator || endLine === -1) {
      // Unterminated conflict — stop scanning, the rest of the file is data.
      break;
    }

    markers.push({
      startLine,
      separatorLine,
      endLine,
      baseLine,
      currentLabel,
      incomingLabel,
      currentLines,
      incomingLines,
      baseLines: sawBase ? baseContent : null,
    });

    index = endLine + 1;
  }

  return markers;
}

/** `true` when `content` contains at least one well-formed conflict region. */
export function hasConflictMarkers(content: string): boolean {
  return detectConflictMarkers(content).length > 0;
}

/**
 * Parse the conflict regions of `content` into hunks with stable ids.
 *
 * The ids are positional (`"conflict-1"`, `"conflict-2"`, …) so the three-way
 * editor can address a hunk by id while the user resolves it.
 */
export function parseConflictHunks(content: string): ConflictHunk[] {
  return detectConflictMarkers(content).map((marker, index) => ({
    id: `conflict-${index + 1}`,
    startLine: marker.startLine,
    endLine: marker.endLine,
    currentLabel: marker.currentLabel,
    incomingLabel: marker.incomingLabel,
    currentLines: marker.currentLines,
    incomingLines: marker.incomingLines,
    baseLines: marker.baseLines,
  }));
}

/**
 * Remove the conflict *delimiter* lines from `content`.
 *
 * Both sides of every conflict are kept, only the `<<<<<<<`, `|||||||`,
 * `=======` and `>>>>>>>` lines disappear. Use {@link selectConflictSide} to
 * additionally drop one of the two sides.
 */
export function stripConflictMarkers(content: string): string {
  const markers = detectConflictMarkers(content);
  if (markers.length === 0) return content;

  const lines = splitLines(content);
  const drop = new Set<number>();
  for (const marker of markers) {
    drop.add(marker.startLine);
    drop.add(marker.separatorLine);
    drop.add(marker.endLine);
    if (marker.baseLine !== null) drop.add(marker.baseLine);
  }

  const kept = lines.filter((_, index) => !drop.has(index));
  return joinLines(kept);
}

/**
 * Keep only one side of every conflict region.
 *
 * `"current"` keeps the *ours* lines, `"incoming"` keeps the *theirs* lines.
 * The resulting content never contains conflict markers.
 */
export function selectConflictSide(
  content: string,
  side: "current" | "incoming",
): string {
  const hunks = parseConflictHunks(content);
  if (hunks.length === 0) return content;

  const lines = splitLines(content);
  const result: string[] = [];

  let cursor = 0;
  for (const hunk of hunks) {
    while (cursor < hunk.startLine) {
      result.push(lines[cursor]);
      cursor += 1;
    }
    result.push(...(side === "current" ? hunk.currentLines : hunk.incomingLines));
    cursor = hunk.endLine + 1;
  }

  while (cursor < lines.length) {
    result.push(lines[cursor]);
    cursor += 1;
  }

  return joinLines(result);
}

/** Options accepted by {@link resolveConflictHunk}. */
export interface ResolveOptions {
  /**
   * When resolving with `"combined"` the caller may supply the text that
   * should be inserted. Falls back to the current side when omitted.
   */
  combinedText?: string;
  /**
   * Manually combined text per hunk id — used by the conflict editor, where
   * every conflicting region can be edited on its own.
   */
  combinedTexts?: Record<string, string>;
}

/**
 * Produce the replacement text for a single conflict hunk.
 *
 * - `"current"` keeps the current (ours) side.
 * - `"incoming"` keeps the incoming (theirs) side.
 * - `"combined"` keeps the current side followed by the incoming side,
 *   optionally overridden through {@link ResolveOptions.combinedText}.
 */
export function resolveConflictHunk(
  hunk: ConflictHunk,
  resolution: ConflictResolution,
  options: ResolveOptions = {},
): string[] {
  switch (resolution) {
    case "current":
      return [...hunk.currentLines];
    case "incoming":
      return [...hunk.incomingLines];
    case "combined":
      if (typeof options.combinedText === "string") {
        return splitLines(options.combinedText);
      }
      return [...hunk.currentLines, ...hunk.incomingLines];
    default:
      return [...hunk.currentLines];
  }
}

/**
 * Apply a set of resolutions to `content`.
 *
 * `resolutions` maps a hunk id (see {@link parseConflictHunks}) to the
 * chosen resolution. Hunks that are not mentioned keep their current side,
 * which means the caller can resolve conflicts one at a time.
 */
export function applyResolutions(
  content: string,
  resolutions: Record<string, ConflictResolution>,
  options: ResolveOptions = {},
): string {
  const hunks = parseConflictHunks(content);
  if (hunks.length === 0) return content;

  const lines = splitLines(content);
  const result: string[] = [];

  let cursor = 0;
  for (const hunk of hunks) {
    while (cursor < hunk.startLine) {
      result.push(lines[cursor]);
      cursor += 1;
    }
    const resolution = resolutions[hunk.id] ?? "current";
    const manual = options.combinedTexts?.[hunk.id];
    result.push(
      ...resolveConflictHunk(hunk, resolution, {
        combinedText:
          typeof manual === "string"
            ? manual
            : typeof options.combinedText === "string"
              ? options.combinedText
              : undefined,
      }),
    );
    cursor = hunk.endLine + 1;
  }

  while (cursor < lines.length) {
    result.push(lines[cursor]);
    cursor += 1;
  }

  return joinLines(result);
}

/**
 * `true` when every conflict region of `content` has a resolution.
 */
export function isFullyResolved(
  content: string,
  resolutions: Record<string, ConflictResolution>,
): boolean {
  const hunks = parseConflictHunks(content);
  if (hunks.length === 0) return true;
  return hunks.every((hunk) => Boolean(resolutions[hunk.id]));
}

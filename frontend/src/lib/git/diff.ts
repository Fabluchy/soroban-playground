// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Minimal line diff used by the three-way merge engine (issue #1727 / FE-27).
 *
 * A classic longest-common-subsequence diff is more than fast enough for the
 * source files handled by the playground and keeps the implementation free of
 * third-party dependencies.
 */

/** Kind of a diff chunk. */
export type DiffOp = "equal" | "insert" | "delete";

/** A run of lines sharing the same operation. */
export interface DiffChunk {
  /** What happened to the lines in this chunk. */
  op: DiffOp;
  /** The lines themselves (without trailing newline). */
  lines: string[];
}

/** A replacement of the base range `[baseStart, baseEnd)` by `lines`. */
export interface Edit {
  /** First base line that is replaced (inclusive). */
  baseStart: number;
  /** Last base line that is replaced (exclusive). */
  baseEnd: number;
  /** Content that replaces the range. */
  lines: string[];
}

/** Above this product of line counts the LCS table gets too expensive. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Compute a line diff between `base` and `other`.
 *
 * The returned chunks cover both inputs completely and in order.
 */
export function diffLines(base: string[], other: string[]): DiffChunk[] {
  if (base.length === 0 && other.length === 0) return [];

  if (base.length === 0) return [{ op: "insert", lines: [...other] }];
  if (other.length === 0) return [{ op: "delete", lines: [...base] }];

  if (base.length * other.length > MAX_LCS_CELLS) {
    // Too large for a full LCS — treat the file as fully replaced.
    return [
      { op: "delete", lines: [...base] },
      { op: "insert", lines: [...other] },
    ];
  }

  const rows = base.length + 1;
  const cols = other.length + 1;
  const table: Uint32Array = new Uint32Array(rows * cols);

  for (let i = base.length - 1; i >= 0; i -= 1) {
    for (let j = other.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        base[i] === other[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }

  const chunks: DiffChunk[] = [];
  const push = (op: DiffOp, line: string) => {
    const last = chunks[chunks.length - 1];
    if (last && last.op === op) last.lines.push(line);
    else chunks.push({ op, lines: [line] });
  };

  let i = 0;
  let j = 0;
  while (i < base.length && j < other.length) {
    if (base[i] === other[j]) {
      push("equal", base[i]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      push("delete", base[i]);
      i += 1;
    } else {
      push("insert", other[j]);
      j += 1;
    }
  }
  while (i < base.length) {
    push("delete", base[i]);
    i += 1;
  }
  while (j < other.length) {
    push("insert", other[j]);
    j += 1;
  }

  return chunks;
}

/**
 * Reduce a diff into a list of replacements relative to the base.
 *
 * Consecutive delete/insert runs collapse into a single {@link Edit}.
 */
export function diffToEdits(base: string[], other: string[]): Edit[] {
  const chunks = diffLines(base, other);
  const edits: Edit[] = [];

  let baseIndex = 0;
  let pendingStart = -1;
  let pendingLines: string[] = [];

  const flush = () => {
    if (pendingStart === -1) return;
    edits.push({
      baseStart: pendingStart,
      baseEnd: baseIndex,
      lines: pendingLines,
    });
    pendingStart = -1;
    pendingLines = [];
  };

  for (const chunk of chunks) {
    if (chunk.op === "equal") {
      flush();
      baseIndex += chunk.lines.length;
      continue;
    }

    if (pendingStart === -1) pendingStart = baseIndex;
    if (chunk.op === "delete") {
      baseIndex += chunk.lines.length;
    } else {
      pendingLines.push(...chunk.lines);
    }
  }
  flush();

  return edits;
}

/**
 * Apply `edits` to `base`, returning the new content.
 *
 * `edits` must be sorted and must not overlap.
 */
export function applyEdits(base: string[], edits: Edit[]): string[] {
  const result: string[] = [];
  let cursor = 0;

  for (const edit of edits) {
    while (cursor < edit.baseStart) {
      result.push(base[cursor]);
      cursor += 1;
    }
    result.push(...edit.lines);
    cursor = Math.max(cursor, edit.baseEnd);
  }

  while (cursor < base.length) {
    result.push(base[cursor]);
    cursor += 1;
  }

  return result;
}

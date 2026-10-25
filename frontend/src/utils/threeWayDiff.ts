export type DiffChunkKind = "add" | "remove" | "modify";

export interface DiffChunk {
  id: string;
  start: number;
  end: number;
  originalLines: string[];
  replacementLines: string[];
  kind: DiffChunkKind;
  header: string;
  additions: number;
  deletions: number;
}

export interface LineDiffResult {
  chunks: DiffChunk[];
  baseLineCount: number;
  modifiedLineCount: number;
  truncated: boolean;
}

export interface ApplyChunkResult {
  ok: boolean;
  code: string;
  reason?: "conflict" | "chunk-not-found";
}

export interface MergeChunksResult {
  code: string;
  applied: number;
  conflicts: number;
}

const MAX_LCS_CELLS = 200_000;

function splitLines(code: string) {
  return code.split(/\r?\n/);
}

function chunkId(start: number, end: number, replacement: string[]): string {
  let hash = 5381;
  const source = `${start}:${end}:${replacement.join("\n")}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 33) ^ source.charCodeAt(index);
  }
  return `${start}-${end}-${(hash >>> 0).toString(16)}`;
}

function chunkKind(start: number, end: number, replacement: string[]) {
  if (start === end) return "add" as const;
  if (replacement.length === 0) return "remove" as const;
  return "modify" as const;
}

function createChunk(
  start: number,
  end: number,
  originalLines: string[],
  replacementLines: string[],
): DiffChunk {
  const additions = replacementLines.length;
  const deletions = originalLines.length;
  return {
    id: chunkId(start, end, replacementLines),
    start,
    end,
    originalLines,
    replacementLines,
    kind: chunkKind(start, end, replacementLines),
    header: `@@ -${start + 1},${deletions} +${start + 1},${additions} @@`,
    additions,
    deletions,
  };
}

interface LineHunk {
  start: number;
  end: number;
  replacement: string[];
}

function createLineHunks(base: string[], changed: string[]): LineHunk[] | null {
  let prefixLength = 0;
  while (
    prefixLength < base.length &&
    prefixLength < changed.length &&
    base[prefixLength] === changed[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < base.length - prefixLength &&
    suffixLength < changed.length - prefixLength &&
    base[base.length - suffixLength - 1] ===
      changed[changed.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const baseMiddle = base.slice(prefixLength, base.length - suffixLength);
  const changedMiddle = changed.slice(
    prefixLength,
    changed.length - suffixLength,
  );
  const columns = changedMiddle.length + 1;
  const rows = baseMiddle.length + 1;
  if (columns * rows > MAX_LCS_CELLS) return null;

  const lcs = new Uint32Array(columns * rows);
  for (let baseIndex = baseMiddle.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (
      let changedIndex = changedMiddle.length - 1;
      changedIndex >= 0;
      changedIndex -= 1
    ) {
      const cell = baseIndex * columns + changedIndex;
      lcs[cell] =
        baseMiddle[baseIndex] === changedMiddle[changedIndex]
          ? lcs[(baseIndex + 1) * columns + changedIndex + 1] + 1
          : Math.max(
              lcs[(baseIndex + 1) * columns + changedIndex],
              lcs[baseIndex * columns + changedIndex + 1],
            );
    }
  }

  const hunks: LineHunk[] = [];
  let current: LineHunk | null = null;
  let baseIndex = 0;
  let changedIndex = 0;

  const finishHunk = () => {
    if (!current) return;
    hunks.push(current);
    current = null;
  };

  while (baseIndex < baseMiddle.length || changedIndex < changedMiddle.length) {
    if (
      baseIndex < baseMiddle.length &&
      changedIndex < changedMiddle.length &&
      baseMiddle[baseIndex] === changedMiddle[changedIndex]
    ) {
      finishHunk();
      baseIndex += 1;
      changedIndex += 1;
      continue;
    }

    current ??= { start: baseIndex, end: baseIndex, replacement: [] };
    const canInsert = changedIndex < changedMiddle.length;
    const shouldInsert =
      canInsert &&
      (baseIndex === baseMiddle.length ||
        lcs[baseIndex * columns + changedIndex + 1] >
          lcs[(baseIndex + 1) * columns + changedIndex]);
    if (shouldInsert) {
      current.replacement.push(changedMiddle[changedIndex]);
      changedIndex += 1;
    } else {
      current.end += 1;
      baseIndex += 1;
    }
  }
  finishHunk();

  return hunks.map((hunk) => ({
    ...hunk,
    start: hunk.start + prefixLength,
    end: hunk.end + prefixLength,
  }));
}

export function computeLineDiff(
  baseCode: string,
  modifiedCode: string,
): LineDiffResult {
  const baseLines = splitLines(baseCode);
  const modifiedLines = splitLines(modifiedCode);
  const hunks = createLineHunks(baseLines, modifiedLines);

  if (!hunks) {
    let prefixLength = 0;
    while (
      prefixLength < baseLines.length &&
      prefixLength < modifiedLines.length &&
      baseLines[prefixLength] === modifiedLines[prefixLength]
    ) {
      prefixLength += 1;
    }

    let suffixLength = 0;
    while (
      suffixLength < baseLines.length - prefixLength &&
      suffixLength < modifiedLines.length - prefixLength &&
      baseLines[baseLines.length - suffixLength - 1] ===
        modifiedLines[modifiedLines.length - suffixLength - 1]
    ) {
      suffixLength += 1;
    }

    const originalLines = baseLines.slice(
      prefixLength,
      baseLines.length - suffixLength,
    );
    const replacementLines = modifiedLines.slice(
      prefixLength,
      modifiedLines.length - suffixLength,
    );

    return {
      chunks:
        originalLines.length === 0 && replacementLines.length === 0
          ? []
          : [
              createChunk(
                prefixLength,
                baseLines.length - suffixLength,
                originalLines,
                replacementLines,
              ),
            ],
      baseLineCount: baseLines.length,
      modifiedLineCount: modifiedLines.length,
      truncated: true,
    };
  }

  return {
    chunks: hunks.map((hunk) =>
      createChunk(
        hunk.start,
        hunk.end,
        baseLines.slice(hunk.start, hunk.end),
        hunk.replacement,
      ),
    ),
    baseLineCount: baseLines.length,
    modifiedLineCount: modifiedLines.length,
    truncated: false,
  };
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  const leftIsInsertion = leftStart === leftEnd;
  const rightIsInsertion = rightStart === rightEnd;

  if (leftIsInsertion && rightIsInsertion) return leftStart === rightStart;
  if (leftIsInsertion) {
    return leftStart > rightStart && leftStart < rightEnd;
  }
  if (rightIsInsertion) {
    return rightStart > leftStart && rightStart < leftEnd;
  }
  return leftStart < rightEnd && rightStart < leftEnd;
}

function hasOverlap(chunk: DiffChunk, chunks: DiffChunk[]) {
  return chunks.some((candidate) =>
    rangesOverlap(chunk.start, chunk.end, candidate.start, candidate.end),
  );
}

function localOffsetFor(chunk: DiffChunk, localChunks: DiffChunk[]) {
  let offset = 0;
  for (const localChunk of localChunks) {
    if (localChunk.id === chunk.id) continue;
    if (localChunk.end <= chunk.start) {
      offset +=
        localChunk.replacementLines.length -
        (localChunk.end - localChunk.start);
    }
  }
  return offset;
}

export function applyVerifiedChunk(
  mainCode: string,
  localCode: string,
  verifiedCode: string,
  chunk: DiffChunk,
): ApplyChunkResult {
  const localDiff = computeLineDiff(mainCode, localCode);
  if (hasOverlap(chunk, localDiff.chunks)) {
    return { ok: false, code: localCode, reason: "conflict" };
  }

  const localLines = splitLines(localCode);
  const offset = localOffsetFor(chunk, localDiff.chunks);
  const localStart = chunk.start + offset;
  const localEnd = chunk.end + offset;

  localLines.splice(
    localStart,
    Math.max(0, localEnd - localStart),
    ...chunk.replacementLines,
  );

  return { ok: true, code: localLines.join("\n") };
}

export function revertLocalChunk(
  mainCode: string,
  localCode: string,
  chunk: DiffChunk,
): ApplyChunkResult {
  const localDiff = computeLineDiff(mainCode, localCode);
  const target = localDiff.chunks.find(
    (candidate) => candidate.id === chunk.id,
  );
  if (!target) {
    return { ok: false, code: localCode, reason: "chunk-not-found" };
  }

  const localLines = splitLines(localCode);
  const previousChunks = localDiff.chunks.filter(
    (candidate) => candidate.start < target.start,
  );
  let offset = 0;
  for (const previous of previousChunks) {
    offset +=
      previous.replacementLines.length - (previous.end - previous.start);
  }

  const localStart = target.start + offset;
  localLines.splice(
    localStart,
    target.replacementLines.length,
    ...target.originalLines,
  );

  return { ok: true, code: localLines.join("\n") };
}

export function mergeVerifiedChunks(
  mainCode: string,
  localCode: string,
  verifiedCode: string,
): MergeChunksResult {
  const verifiedDiff = computeLineDiff(mainCode, verifiedCode);
  const descendingChunks = [...verifiedDiff.chunks].sort(
    (left, right) => right.start - left.start,
  );

  let code = localCode;
  let applied = 0;
  let conflicts = 0;

  for (const chunk of descendingChunks) {
    const result = applyVerifiedChunk(mainCode, code, verifiedCode, chunk);
    if (!result.ok) {
      conflicts += 1;
      continue;
    }
    code = result.code;
    applied += 1;
  }

  return { code, applied, conflicts };
}

export function chunkSummary(chunk: DiffChunk) {
  return `+${chunk.additions} -${chunk.deletions}`;
}

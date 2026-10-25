/**
 * Unit tests for the conflict marker detection and resolution parsing
 * (issue #1727 / FE-27).
 */

import {
  applyResolutions,
  CONFLICT_BASE_MARKER,
  CONFLICT_END_MARKER,
  CONFLICT_SEPARATOR_MARKER,
  CONFLICT_START_MARKER,
  detectConflictMarkers,
  hasConflictMarkers,
  isFullyResolved,
  joinLines,
  parseConflictHunks,
  resolveConflictHunk,
  selectConflictSide,
  splitLines,
  stripConflictMarkers,
} from "@/lib/git/conflicts";

const CLASSIC_CONFLICT = [
  "fn main() {",
  `${CONFLICT_START_MARKER} HEAD`,
  '    println!("current");',
  CONFLICT_SEPARATOR_MARKER,
  '    println!("incoming");',
  `${CONFLICT_END_MARKER} feature/hello`,
  "}",
].join("\n");

const DIFF3_CONFLICT = [
  `${CONFLICT_START_MARKER} HEAD`,
  "current",
  CONFLICT_BASE_MARKER,
  "base",
  CONFLICT_SEPARATOR_MARKER,
  "incoming",
  `${CONFLICT_END_MARKER} feature/hello`,
].join("\n");

describe("git/conflicts – line helpers", () => {
  it("splits content into lines and drops the trailing newline", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });

  it("joins lines back and restores the trailing newline", () => {
    expect(joinLines(["a", "b"])).toBe("a\nb\n");
    expect(joinLines([])).toBe("");
  });
});

describe("git/conflicts – detection", () => {
  it("reports no conflicts for a clean file", () => {
    expect(detectConflictMarkers("fn main() {}\n")).toEqual([]);
    expect(hasConflictMarkers("fn main() {}\n")).toBe(false);
  });

  it("detects a classic conflict region", () => {
    const markers = detectConflictMarkers(CLASSIC_CONFLICT);

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      startLine: 1,
      separatorLine: 3,
      endLine: 5,
      currentLabel: "HEAD",
      incomingLabel: "feature/hello",
      currentLines: ['    println!("current");'],
      incomingLines: ['    println!("incoming");'],
      baseLines: null,
    });
  });

  it("detects a diff3 conflict region including the ancestor", () => {
    const markers = detectConflictMarkers(DIFF3_CONFLICT);

    expect(markers).toHaveLength(1);
    expect(markers[0].baseLines).toEqual(["base"]);
    expect(markers[0].currentLines).toEqual(["current"]);
    expect(markers[0].incomingLines).toEqual(["incoming"]);
    expect(markers[0].baseLine).toBe(2);
  });

  it("detects several independent conflict regions", () => {
    const content = [
      `${CONFLICT_START_MARKER} HEAD`,
      "one",
      CONFLICT_SEPARATOR_MARKER,
      "two",
      `${CONFLICT_END_MARKER} other`,
      "middle",
      `${CONFLICT_START_MARKER} HEAD`,
      "three",
      CONFLICT_SEPARATOR_MARKER,
      "four",
      `${CONFLICT_END_MARKER} other`,
    ].join("\n");

    const markers = detectConflictMarkers(content);
    expect(markers).toHaveLength(2);
    expect(markers[0].currentLines).toEqual(["one"]);
    expect(markers[1].currentLines).toEqual(["three"]);
    expect(hasConflictMarkers(content)).toBe(true);
  });

  it("ignores an unterminated conflict region", () => {
    const content = [
      `${CONFLICT_START_MARKER} HEAD`,
      "one",
      CONFLICT_SEPARATOR_MARKER,
      "two",
    ].join("\n");

    expect(detectConflictMarkers(content)).toEqual([]);
  });

  it("parses hunks with stable positional ids", () => {
    const hunks = parseConflictHunks(CLASSIC_CONFLICT);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].id).toBe("conflict-1");
    expect(hunks[0].currentLabel).toBe("HEAD");
    expect(hunks[0].incomingLabel).toBe("feature/hello");
  });

  it("numbers hunks sequentially", () => {
    const content = [
      `${CONFLICT_START_MARKER} HEAD`,
      "one",
      CONFLICT_SEPARATOR_MARKER,
      "two",
      `${CONFLICT_END_MARKER} other`,
      `${CONFLICT_START_MARKER} HEAD`,
      "three",
      CONFLICT_SEPARATOR_MARKER,
      "four",
      `${CONFLICT_END_MARKER} other`,
    ].join("\n");

    expect(parseConflictHunks(content).map((hunk) => hunk.id)).toEqual([
      "conflict-1",
      "conflict-2",
    ]);
  });
});

describe("git/conflicts – resolution parsing", () => {
  it("resolves a hunk to the current side", () => {
    const [hunk] = parseConflictHunks(CLASSIC_CONFLICT);
    expect(resolveConflictHunk(hunk, "current")).toEqual([
      '    println!("current");',
    ]);
  });

  it("resolves a hunk to the incoming side", () => {
    const [hunk] = parseConflictHunks(CLASSIC_CONFLICT);
    expect(resolveConflictHunk(hunk, "incoming")).toEqual([
      '    println!("incoming");',
    ]);
  });

  it("resolves a hunk to the combination of both sides", () => {
    const [hunk] = parseConflictHunks(CLASSIC_CONFLICT);
    expect(resolveConflictHunk(hunk, "combined")).toEqual([
      '    println!("current");',
      '    println!("incoming");',
    ]);
  });

  it("uses the manually combined text when provided", () => {
    const [hunk] = parseConflictHunks(CLASSIC_CONFLICT);
    expect(
      resolveConflictHunk(hunk, "combined", { combinedText: "manual\n" }),
    ).toEqual(["manual"]);
  });

  it("applies a resolution and keeps the surrounding lines intact", () => {
    const resolved = applyResolutions(CLASSIC_CONFLICT, {
      "conflict-1": "incoming",
    });

    expect(resolved).toBe(
      [
        "fn main() {",
        '    println!("incoming");',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("keeps the current side when a hunk has no resolution", () => {
    const resolved = applyResolutions(CLASSIC_CONFLICT, {});
    expect(resolved).toContain('    println!("current");');
    expect(resolved).not.toContain(CONFLICT_START_MARKER);
  });

  it("resolves several hunks independently", () => {
    const content = [
      `${CONFLICT_START_MARKER} HEAD`,
      "one",
      CONFLICT_SEPARATOR_MARKER,
      "two",
      `${CONFLICT_END_MARKER} other`,
      `${CONFLICT_START_MARKER} HEAD`,
      "three",
      CONFLICT_SEPARATOR_MARKER,
      "four",
      `${CONFLICT_END_MARKER} other`,
    ].join("\n");

    const resolved = applyResolutions(content, {
      "conflict-1": "incoming",
      "conflict-2": "current",
    });

    expect(resolved).toBe("two\nthree\n");
  });

  it("strips the markers but keeps both sides", () => {
    const stripped = stripConflictMarkers(CLASSIC_CONFLICT);
    expect(stripped).toBe(
      [
        "fn main() {",
        '    println!("current");',
        '    println!("incoming");',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("selects a single side of every conflict", () => {
    expect(selectConflictSide(CLASSIC_CONFLICT, "current")).toBe(
      ["fn main() {", '    println!("current");', "}", ""].join("\n"),
    );
    expect(selectConflictSide(CLASSIC_CONFLICT, "incoming")).toBe(
      ["fn main() {", '    println!("incoming");', "}", ""].join("\n"),
    );
  });

  it("knows when every conflict has been resolved", () => {
    expect(isFullyResolved(CLASSIC_CONFLICT, {})).toBe(false);
    expect(isFullyResolved(CLASSIC_CONFLICT, { "conflict-1": "current" })).toBe(
      true,
    );
    expect(isFullyResolved("clean\n", {})).toBe(true);
  });
});

/**
 * Unit tests for the three-way merge engine (issue #1727 / FE-27).
 */

import { threeWayMerge } from "@/lib/git/merge";
import { diffLines, diffToEdits } from "@/lib/git/diff";
import { parseConflictHunks } from "@/lib/git/conflicts";

describe("git/diff", () => {
  it("reports an empty diff for identical inputs", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([
      { op: "equal", lines: ["a", "b"] },
    ]);
  });

  it("reports a replacement", () => {
    const chunks = diffLines(["a", "b", "c"], ["a", "B", "c"]);
    expect(chunks).toEqual([
      { op: "equal", lines: ["a"] },
      { op: "delete", lines: ["b"] },
      { op: "insert", lines: ["B"] },
      { op: "equal", lines: ["c"] },
    ]);
  });

  it("reduces a diff into base relative edits", () => {
    expect(diffToEdits(["a", "b", "c"], ["a", "B", "c"])).toEqual([
      { baseStart: 1, baseEnd: 2, lines: ["B"] },
    ]);
  });

  it("treats a removal as an edit with an empty replacement", () => {
    expect(diffToEdits(["a", "b"], ["a"])).toEqual([
      { baseStart: 1, baseEnd: 2, lines: [] },
    ]);
  });
});

describe("git/merge – three-way merge", () => {
  it("returns the incoming side when only the incoming side changed", () => {
    const result = threeWayMerge("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n");
    expect(result.status).toBe("clean");
    expect(result.content).toBe("a\nb\nC\n");
    expect(result.conflicts).toEqual([]);
  });

  it("returns the current side when only the current side changed", () => {
    const result = threeWayMerge("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n");
    expect(result.status).toBe("clean");
    expect(result.content).toBe("a\nB\nc\n");
  });

  it("combines changes made on different lines", () => {
    const result = threeWayMerge("a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n");
    expect(result.status).toBe("clean");
    expect(result.content).toBe("a\nB\nC\n");
    expect(result.conflicts).toEqual([]);
  });

  it("accepts identical changes made on both sides", () => {
    const result = threeWayMerge("a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\n");
    expect(result.status).toBe("clean");
    expect(result.content).toBe("a\nB\nc\n");
  });

  it("reports a conflict when both sides changed the same line", () => {
    const result = threeWayMerge("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");

    expect(result.status).toBe("conflict");
    expect(result.content).toContain("<<<<<<< HEAD");
    expect(result.content).toContain("=======");
    expect(result.content).toContain(">>>>>>> incoming");
    expect(result.content).toContain("X");
    expect(result.content).toContain("Y");
  });

  it("places the conflict markers on accurate line numbers", () => {
    const result = threeWayMerge("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");
    const [hunk] = result.conflicts;

    expect(hunk.id).toBe("conflict-1");
    expect(hunk.startLine).toBe(1);
    expect(hunk.endLine).toBe(5);
    expect(hunk.currentLines).toEqual(["X"]);
    expect(hunk.incomingLines).toEqual(["Y"]);

    // The reported positions must match the produced content.
    const reparsed = parseConflictHunks(result.content);
    expect(reparsed[0].startLine).toBe(hunk.startLine);
    expect(reparsed[0].endLine).toBe(hunk.endLine);
  });

  it("keeps the untouched lines around a conflict", () => {
    const result = threeWayMerge(
      "head\nbase\ntail\n",
      "head\ncurrent\ntail\n",
      "head\nincoming\ntail\n",
    );

    expect(result.content).toBe(
      [
        "head",
        "<<<<<<< HEAD",
        "current",
        "=======",
        "incoming",
        ">>>>>>> incoming",
        "tail",
        "",
      ].join("\n"),
    );
  });

  it("uses the supplied labels in the markers", () => {
    const result = threeWayMerge("a\n", "x\n", "y\n", {
      currentLabel: "main",
      incomingLabel: "feature/x",
    });

    expect(result.content).toContain("<<<<<<< main");
    expect(result.content).toContain(">>>>>>> feature/x");
  });

  it("reports several conflicts independently", () => {
    const base = "a\nb\nc\nd\ne\n";
    const current = "a\nX\nc\nY\ne\n";
    const incoming = "a\nZ\nc\nW\ne\n";
    const result = threeWayMerge(base, current, incoming);

    expect(result.status).toBe("conflict");
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts[0].currentLines).toEqual(["X"]);
    expect(result.conflicts[1].currentLines).toEqual(["Y"]);
    expect(result.conflicts[1].incomingLines).toEqual(["W"]);
  });
});

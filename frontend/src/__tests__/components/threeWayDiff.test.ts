import {
  applyVerifiedChunk,
  computeLineDiff,
  mergeVerifiedChunks,
  revertLocalChunk,
} from "../../utils/threeWayDiff";

describe("three-way diff calculation", () => {
  it("detects modified and added lines against the main baseline", () => {
    const main = "fn a() {}\nfn b() {}\nfn c() {}\n";
    const local = "fn a() {}\nfn b_changed() {}\nfn c() {}\nfn d() {}\n";
    const diff = computeLineDiff(main, local);

    expect(diff.chunks).toHaveLength(2);
    expect(diff.chunks[0].kind).toBe("modify");
    expect(diff.chunks[0].start).toBe(1);
    expect(diff.chunks[0].replacementLines).toEqual(["fn b_changed() {}"]);
    expect(diff.chunks[1].kind).toBe("add");
    expect(diff.chunks[1].replacementLines).toEqual(["fn d() {}"]);
  });

  it("detects removed lines", () => {
    const main = "a\nb\nc\n";
    const local = "a\nc\n";
    const diff = computeLineDiff(main, local);

    expect(diff.chunks).toHaveLength(1);
    expect(diff.chunks[0].kind).toBe("remove");
    expect(diff.chunks[0].originalLines).toEqual(["b"]);
    expect(diff.chunks[0].replacementLines).toEqual([]);
  });

  it("applies a verified chunk without corrupting local offsets", () => {
    const main = "a\nb\nc\n";
    const local = "a\ninserted\nb\nc\n";
    const verified = "a\nb\nc_verified\n";

    const verifiedChunk = computeLineDiff(main, verified).chunks[0];
    const result = applyVerifiedChunk(main, local, verified, verifiedChunk);

    expect(result.ok).toBe(true);
    expect(result.code).toBe("a\ninserted\nb\nc_verified\n");
  });

  it("rejects cherry-picks that overlap local edits", () => {
    const main = "a\nb\nc\n";
    const local = "a\nb_local\nc\n";
    const verified = "a\nb_verified\nc\n";

    const verifiedChunk = computeLineDiff(main, verified).chunks[0];
    const result = applyVerifiedChunk(main, local, verified, verifiedChunk);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("conflict");
    expect(result.code).toBe(local);
  });

  it("reverts a local chunk back to the main baseline", () => {
    const main = "a\nb\nc\n";
    const local = "a\nb_local\nc\n";
    const localChunk = computeLineDiff(main, local).chunks[0];

    const result = revertLocalChunk(main, local, localChunk);

    expect(result.ok).toBe(true);
    expect(result.code).toBe(main);
  });

  it("merges non-overlapping verified chunks into the working buffer", () => {
    const main = "a\nb\nc\nd\n";
    const local = "a\nb_local\nc\nd\n";
    const verified = "a\nb\nc_verified\nd\n";

    const merged = mergeVerifiedChunks(main, local, verified);

    expect(merged.code).toBe("a\nb_local\nc_verified\nd\n");
    expect(merged.applied).toBe(1);
    expect(merged.conflicts).toBe(0);
  });

  it("reports conflicting verified chunks during merge", () => {
    const main = "a\nb\nc\n";
    const local = "a\nb_local\nc\n";
    const verified = "a\nb_verified\nc\n";

    const merged = mergeVerifiedChunks(main, local, verified);

    expect(merged.code).toBe(local);
    expect(merged.applied).toBe(0);
    expect(merged.conflicts).toBe(1);
  });

  it("uses a bounded fallback for very large fully divergent diffs", () => {
    const main = Array.from(
      { length: 6_000 },
      (_, index) => `main ${index}`,
    ).join("\n");
    const local = Array.from(
      { length: 6_000 },
      (_, index) => `local ${index}`,
    ).join("\n");

    const diff = computeLineDiff(main, local);

    expect(diff.baseLineCount).toBe(6_000);
    expect(diff.modifiedLineCount).toBe(6_000);
    expect(diff.truncated).toBe(true);
    expect(diff.chunks).toHaveLength(1);
  });

  it("handles a small change inside a large file without quadratic work", () => {
    const main = Array.from({ length: 6_000 }, (_, index) => `line ${index}`);
    const local = [...main];
    local[3_000] = "line changed";

    const diff = computeLineDiff(main.join("\n"), local.join("\n"));

    expect(diff.truncated).toBe(false);
    expect(diff.chunks).toHaveLength(1);
    expect(diff.chunks[0].start).toBe(3_000);
    expect(diff.chunks[0].replacementLines).toEqual(["line changed"]);
  });
});

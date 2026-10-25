/**
 * Unit tests for the Git file explorer helpers (issue #1727 / FE-27).
 */

import { buildFileTreeNodes } from "@/lib/git/fileTree";

describe("lib/git/fileTree", () => {
  it("returns an empty tree for no paths", () => {
    expect(buildFileTreeNodes([])).toEqual([]);
  });

  it("nests files into folders", () => {
    const nodes = buildFileTreeNodes(["src/lib.rs", "src/util/helpers.rs"]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: "src", name: "src", type: "folder" });
    expect(nodes[0].children).toHaveLength(2);
    // Folders are rendered before files.
    expect(nodes[0].children?.[0]).toMatchObject({
      id: "src/util",
      name: "util",
      type: "folder",
    });
    expect(nodes[0].children?.[1]).toMatchObject({
      id: "src/lib.rs",
      name: "lib.rs",
      type: "file",
    });
  });

  it("sorts folders before files", () => {
    const nodes = buildFileTreeNodes(["README.md", "src/lib.rs", "Cargo.toml"]);
    expect(nodes.map((node) => node.name)).toEqual(["src", "Cargo.toml", "README.md"]);
  });

  it("marks modified files as dirty", () => {
    const nodes = buildFileTreeNodes(["src/lib.rs"], [
      { path: "src/lib.rs", status: "modified" },
    ]);

    const file = nodes[0].children?.[0];
    expect(file?.dirty).toBe(true);
    expect(file?.status).toBe("M");
  });

  it("marks added files with the A badge", () => {
    const nodes = buildFileTreeNodes(["Cargo.toml"], [
      { path: "Cargo.toml", status: "added" },
    ]);

    expect(nodes[0].dirty).toBe(true);
    expect(nodes[0].status).toBe("A");
  });

  it("marks conflicted files with the U badge", () => {
    const nodes = buildFileTreeNodes(["src/lib.rs"], [
      { path: "src/lib.rs", status: "conflicted" },
    ]);

    expect(nodes[0].children?.[0].status).toBe("U");
  });

  it("leaves clean files untouched", () => {
    const nodes = buildFileTreeNodes(["src/lib.rs"]);
    const file = nodes[0].children?.[0];
    expect(file?.dirty).toBeUndefined();
    expect(file?.status).toBeUndefined();
  });

  it("does not mark folders as dirty", () => {
    const nodes = buildFileTreeNodes(["src/lib.rs"], [
      { path: "src/lib.rs", status: "modified" },
    ]);
    expect(nodes[0].dirty).toBeUndefined();
  });
});

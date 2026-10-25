/**
 * Unit tests for the Octokit based GitHub integration (issue #1727 / FE-27).
 */

import {
  canAccessRepository,
  createRemoteBranch,
  fetchAccount,
  listRemoteBranches,
  pullBranch,
  pushBranch,
  type GitHubClient,
} from "@/lib/git/github";
import type { GitCommit } from "@/lib/git/types";

interface Call {
  route: string;
  params?: Record<string, unknown>;
}

/** Build a stub client that answers the given routes. */
function createStub(
  responses: Record<string, unknown>,
): GitHubClient & { calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    calls,
    async request(route: string, params?: Record<string, unknown>) {
      calls.push({ route, params });
      const key = Object.keys(responses).find((candidate) =>
        route.startsWith(candidate),
      );
      if (!key) {
        throw new Error(`Unexpected route: ${route}`);
      }
      const value = responses[key];
      if (value instanceof Error) throw value;
      return { data: value };
    },
  };
  return client as GitHubClient & { calls: Call[] };
}

const COMMIT: GitCommit = {
  id: "a".repeat(40),
  message: "Add feature",
  author: { name: "Ada", email: "ada@example.dev" },
  timestamp: 1_700_000_000_000,
  tree: { "src/lib.rs": "fn main() {}\n" },
  parents: [],
};

describe("lib/git/github – account", () => {
  it("reads the authenticated account", async () => {
    const client = createStub({
      "GET /user": { login: "ada", name: "Ada L", avatar_url: "https://x/y.png" },
    });

    await expect(fetchAccount(client)).resolves.toEqual({
      login: "ada",
      name: "Ada L",
      avatarUrl: "https://x/y.png",
    });
    expect(client.calls[0].route).toBe("GET /user");
  });

  it("falls back to sane defaults", async () => {
    const client = createStub({ "GET /user": {} });
    await expect(fetchAccount(client)).resolves.toEqual({
      login: "unknown",
      name: null,
      avatarUrl: "",
    });
  });

  it("confirms repository access", async () => {
    const client = createStub({ "GET /repos": { id: 1 } });
    await expect(
      canAccessRepository(client, { owner: "o", repo: "r" }),
    ).resolves.toBe(true);
  });

  it("reports a missing repository", async () => {
    const client = createStub({ "GET /repos": new Error("Not Found") });
    await expect(
      canAccessRepository(client, { owner: "o", repo: "r" }),
    ).resolves.toBe(false);
  });
});

describe("lib/git/github – push", () => {
  it("creates blobs, a tree, a commit and the branch ref", async () => {
    const client = createStub({
      "POST /repos/{owner}/{repo}/git/blobs": { sha: "blob-sha" },
      "POST /repos/{owner}/{repo}/git/trees": { sha: "tree-sha" },
      "POST /repos/{owner}/{repo}/git/commits": {
        sha: "commit-sha",
        html_url: "https://github.com/o/r/commit/commit-sha",
      },
      "POST /repos/{owner}/{repo}/git/refs": { ref: "refs/heads/main" },
    });

    const result = await pushBranch(client, {
      owner: "o",
      repo: "r",
      branch: "main",
      commits: [COMMIT],
      tree: COMMIT.tree,
    });

    expect(result).toEqual({
      sha: "commit-sha",
      url: "https://github.com/o/r/commit/commit-sha",
    });

    const routes = client.calls.map((call) => call.route);
    expect(routes).toEqual([
      "POST /repos/{owner}/{repo}/git/blobs",
      "POST /repos/{owner}/{repo}/git/trees",
      "POST /repos/{owner}/{repo}/git/commits",
      "POST /repos/{owner}/{repo}/git/refs",
    ]);

    const treeCall = client.calls[1];
    expect(treeCall.params?.tree).toEqual([
      { path: "src/lib.rs", mode: "100644", type: "blob", sha: "blob-sha" },
    ]);
  });

  it("updates an existing ref instead of creating it twice", async () => {
    const client = createStub({
      "POST /repos/{owner}/{repo}/git/blobs": { sha: "blob-sha" },
      "POST /repos/{owner}/{repo}/git/trees": { sha: "tree-sha" },
      "POST /repos/{owner}/{repo}/git/commits": { sha: "commit-sha" },
      "POST /repos/{owner}/{repo}/git/refs": new Error("Reference already exists"),
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}": { ref: "refs/heads/main" },
    });

    await pushBranch(client, {
      owner: "o",
      repo: "r",
      branch: "main",
      commits: [COMMIT],
      tree: COMMIT.tree,
    });

    const patch = client.calls.find((call) =>
      call.route.startsWith("PATCH"),
    );
    expect(patch).toBeDefined();
    expect(patch?.params?.sha).toBe("commit-sha");
  });

  it("passes the parent sha of the pushed commit", async () => {
    const client = createStub({
      "POST /repos/{owner}/{repo}/git/blobs": { sha: "blob-sha" },
      "POST /repos/{owner}/{repo}/git/trees": { sha: "tree-sha" },
      "POST /repos/{owner}/{repo}/git/commits": { sha: "commit-sha" },
      "POST /repos/{owner}/{repo}/git/refs": { ref: "refs/heads/main" },
    });

    await pushBranch(client, {
      owner: "o",
      repo: "r",
      branch: "main",
      commits: [COMMIT],
      tree: COMMIT.tree,
      parentSha: "parent-sha",
    });

    const commitCall = client.calls.find((call) => call.route.includes("commits"));
    expect(commitCall?.params?.parents).toEqual(["parent-sha"]);
  });

  it("refuses to push without commits", async () => {
    const client = createStub({});
    await expect(
      pushBranch(client, {
        owner: "o",
        repo: "r",
        branch: "main",
        commits: [],
        tree: {},
      }),
    ).rejects.toThrow("nothing to push");
  });
});

describe("lib/git/github – pull", () => {
  it("downloads the files of the remote branch", async () => {
    const client = createStub({
      "GET /repos/{owner}/{repo}/git/ref": { object: { sha: "head-sha" } },
      "GET /repos/{owner}/{repo}/git/commits": {
        tree: { sha: "tree-sha" },
      },
      "GET /repos/{owner}/{repo}/git/trees": {
        tree: [{ path: "src/lib.rs", type: "blob", sha: "blob-sha" }],
      },
      "GET /repos/{owner}/{repo}/git/blobs": {
        content: Buffer.from("fn main() {}\n", "utf-8").toString("base64"),
      },
    });

    const result = await pullBranch(client, {
      owner: "o",
      repo: "r",
      branch: "main",
    });

    expect(result.branch).toBe("main");
    expect(result.sha).toBe("head-sha");
    expect(result.files).toEqual([
      { path: "src/lib.rs", content: "fn main() {}\n" },
    ]);
  });

  it("fails when the branch cannot be resolved", async () => {
    const client = createStub({ "GET /repos/{owner}/{repo}/git/ref": {} });
    await expect(
      pullBranch(client, { owner: "o", repo: "r", branch: "nope" }),
    ).rejects.toThrow('"nope" could not be resolved');
  });

  it("ignores tree entries that are not blobs", async () => {
    const client = createStub({
      "GET /repos/{owner}/{repo}/git/ref": { object: { sha: "head-sha" } },
      "GET /repos/{owner}/{repo}/git/commits": { tree: { sha: "tree-sha" } },
      "GET /repos/{owner}/{repo}/git/trees": {
        tree: [{ path: "src", type: "tree", sha: "tree-sha" }],
      },
    });

    const result = await pullBranch(client, {
      owner: "o",
      repo: "r",
      branch: "main",
    });
    expect(result.files).toEqual([]);
  });
});

describe("lib/git/github – branches", () => {
  it("creates a branch on the remote", async () => {
    const client = createStub({ "POST /repos/{owner}/{repo}/git/refs": {} });
    await createRemoteBranch(client, {
      owner: "o",
      repo: "r",
      branch: "feature/x",
      sha: "abc",
    });

    expect(client.calls[0].params).toMatchObject({
      ref: "refs/heads/feature/x",
      sha: "abc",
    });
  });

  it("lists the remote branches", async () => {
    const client = createStub({
      "GET /repos/{owner}/{repo}/branches": [
        { name: "main", commit: { sha: "aaa" } },
        { name: "feature/x", commit: { sha: "bbb" } },
      ],
    });

    await expect(
      listRemoteBranches(client, { owner: "o", repo: "r" }),
    ).resolves.toEqual([
      { name: "main", sha: "aaa" },
      { name: "feature/x", sha: "bbb" },
    ]);
  });
});

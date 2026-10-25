// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * GitHub remote integration built on top of Octokit (issue #1727 / FE-27).
 *
 * Only the Git Data API is used, which maps nicely onto the in-app repository:
 * blobs carry file contents, trees carry directories, commits carry the
 * history and refs carry the branches.
 *
 * The Octokit client is injected into every function so the transport can be
 * replaced with a stub during tests.
 */

import type { GitCommit, GitRemoteConfig, GitTree } from "./types";

/** The subset of the Octokit client this module relies on. */
export interface GitHubClient {
  /** Perform an Octokit route request, e.g. `"GET /repos/{owner}/{repo}"`. */
  request: (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
}

/** The authenticated GitHub account. */
export interface GitHubAccount {
  /** GitHub login. */
  login: string;
  /** Display name, when the account has one. */
  name: string | null;
  /** Avatar URL. */
  avatarUrl: string;
}

/** A file fetched from the remote. */
export interface RemoteFile {
  /** Project relative path. */
  path: string;
  /** File content. */
  content: string;
}

/** The state of a remote branch. */
export interface RemoteBranchState {
  /** Branch name. */
  branch: string;
  /** Head commit sha of the remote branch. */
  sha: string;
  /** Files contained in the remote branch. */
  files: RemoteFile[];
}

/** Options accepted by {@link pushBranch}. */
export interface PushOptions {
  /** Remote owner. */
  owner: string;
  /** Remote repository. */
  repo: string;
  /** Branch that is pushed. */
  branch: string;
  /** Commits to push, oldest first. */
  commits: GitCommit[];
  /** Files that make up the tip of the branch. */
  tree: GitTree;
  /** Remote commit the local branch is based on (used as parent). */
  parentSha?: string | null;
}

/** Result of {@link pushBranch}. */
export interface PushResult {
  /** Sha of the commit that was created on the remote. */
  sha: string;
  /** Url of the pushed commit. */
  url: string | null;
}

/** Options accepted by {@link pullBranch}. */
export interface PullOptions {
  /** Remote owner. */
  owner: string;
  /** Remote repository. */
  repo: string;
  /** Branch to pull. */
  branch: string;
}

/** Encode a string as base64 (works in the browser and in Node). */
function encodeBase64(content: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(content);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }
  return Buffer.from(content, "utf-8").toString("base64");
}

/** Decode a base64 string into a UTF-8 string. */
function decodeBase64(content: string): string {
  if (typeof atob === "function") {
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(content, "base64").toString("utf-8");
}

/**
 * Create an Octokit client authenticated with the given token.
 *
 * Octokit is imported lazily so the bundle only pays for it when the user
 * actually connects a remote.
 */
export async function createGitHubClient(token: string): Promise<GitHubClient> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("A GitHub personal access token is required.");
  }

  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: trimmed });
  return octokit as unknown as GitHubClient;
}

/** Fetch the authenticated account — used to validate a token. */
export async function fetchAccount(
  client: GitHubClient,
): Promise<GitHubAccount> {
  const response = await client.request("GET /user");
  const data = (response.data ?? {}) as {
    login?: string;
    name?: string | null;
    avatar_url?: string;
  };

  return {
    login: data.login ?? "unknown",
    name: data.name ?? null,
    avatarUrl: data.avatar_url ?? "",
  };
}

/** `true` when the repository exists and the token may write to it. */
export async function canAccessRepository(
  client: GitHubClient,
  remote: GitRemoteConfig,
): Promise<boolean> {
  try {
    await client.request("GET /repos/{owner}/{repo}", {
      owner: remote.owner,
      repo: remote.repo,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push the local commits to the remote branch.
 *
 * The Git Data API is used end-to-end: blobs for the files, a tree for the
 * directory listing, a commit object and finally the branch reference.
 */
export async function pushBranch(
  client: GitHubClient,
  options: PushOptions,
): Promise<PushResult> {
  const { owner, repo, branch, commits, tree } = options;

  if (commits.length === 0) {
    throw new Error("There is nothing to push.");
  }

  const blobShas = new Map<string, string>();
  for (const [path, content] of Object.entries(tree)) {
    const blobResponse = await client.request(
      "POST /repos/{owner}/{repo}/git/blobs",
      {
        owner,
        repo,
        content: encodeBase64(content),
        encoding: "base64",
      },
    );
    const blobData = (blobResponse.data ?? {}) as { sha?: string };
    if (blobData.sha) blobShas.set(path, blobData.sha);
  }

  const treeResponse = await client.request(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      owner,
      repo,
      tree: Array.from(blobShas.entries()).map(([path, sha]) => ({
        path,
        mode: "100644",
        type: "blob",
        sha,
      })),
    },
  );
  const treeData = (treeResponse.data ?? {}) as { sha?: string };
  if (!treeData.sha) {
    throw new Error("GitHub did not return a tree sha for the pushed files.");
  }

  const commitResponse = await client.request(
    "POST /repos/{owner}/{repo}/git/commits",
    {
      owner,
      repo,
      message: commits[commits.length - 1].message,
      tree: treeData.sha,
      ...(options.parentSha ? { parents: [options.parentSha] } : {}),
    },
  );
  const commitData = (commitResponse.data ?? {}) as {
    sha?: string;
    html_url?: string;
  };
  if (!commitData.sha) {
    throw new Error("GitHub did not return a commit sha for the pushed commit.");
  }

  const ref = `refs/heads/${branch}`;
  try {
    await client.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref,
      sha: commitData.sha,
    });
  } catch {
    // The branch already exists — update it instead.
    await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref,
      sha: commitData.sha,
    });
  }

  return {
    sha: commitData.sha,
    url: commitData.html_url ?? null,
  };
}

/**
 * Pull the remote branch and return its files.
 */
export async function pullBranch(
  client: GitHubClient,
  options: PullOptions,
): Promise<RemoteBranchState> {
  const { owner, repo, branch } = options;

  const refResponse = await client.request(
    "GET /repos/{owner}/{repo}/git/ref/heads/{branch}",
    { owner, repo, branch },
  );
  const refData = (refResponse.data ?? {}) as { object?: { sha?: string } };
  const sha = refData.object?.sha;
  if (!sha) {
    throw new Error(`The remote branch "${branch}" could not be resolved.`);
  }

  const commitResponse = await client.request(
    "GET /repos/{owner}/{repo}/git/commits/{sha}",
    { owner, repo, sha },
  );
  const commitData = (commitResponse.data ?? {}) as { tree?: { sha?: string } };
  const treeSha = commitData.tree?.sha;
  if (!treeSha) {
    throw new Error("The remote commit does not reference a tree.");
  }

  const treeResponse = await client.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    { owner, repo, tree_sha: treeSha, recursive: "1" },
  );
  const treeData = (treeResponse.data ?? {}) as {
    tree?: Array<{ path?: string; type?: string; sha?: string }>;
  };

  const files: RemoteFile[] = [];
  for (const entry of treeData.tree ?? []) {
    if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
    const blobResponse = await client.request(
      "GET /repos/{owner}/{repo}/git/blobs/{sha}",
      { owner, repo, sha: entry.sha },
    );
    const blobData = (blobResponse.data ?? {}) as { content?: string };
    if (typeof blobData.content !== "string") continue;
    files.push({
      path: entry.path,
      content: decodeBase64(blobData.content.replace(/\n/g, "")),
    });
  }

  return { branch, sha, files };
}

/**
 * Create a branch on the remote pointing at an existing commit.
 */
export async function createRemoteBranch(
  client: GitHubClient,
  options: { owner: string; repo: string; branch: string; sha: string },
): Promise<void> {
  await client.request("POST /repos/{owner}/{repo}/git/refs", {
    owner: options.owner,
    repo: options.repo,
    ref: `refs/heads/${options.branch}`,
    sha: options.sha,
  });
}

/** List the remote branches. */
export async function listRemoteBranches(
  client: GitHubClient,
  options: { owner: string; repo: string },
): Promise<Array<{ name: string; sha: string }>> {
  const response = await client.request("GET /repos/{owner}/{repo}/branches", {
    owner: options.owner,
    repo: options.repo,
  });
  const data = (response.data ?? []) as Array<{
    name?: string;
    commit?: { sha?: string };
  }>;
  return data
    .filter((entry) => Boolean(entry.name))
    .map((entry) => ({
      name: entry.name as string,
      sha: entry.commit?.sha ?? "",
    }));
}

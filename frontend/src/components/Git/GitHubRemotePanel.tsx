"use client";

/**
 * GitHubRemotePanel – Personal Access Token authentication and remote
 * push/pull controls (issue #1727 / FE-27).
 *
 * The token is stored encrypted (AES-GCM, key derived from a per-device
 * secret) — see `@/lib/git/tokenStorage`. The panel never keeps the token in
 * component state longer than necessary and never renders it back.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  CloudDownload,
  CloudUpload,
  KeyRound,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import {
  clearToken,
  getTokenInfo,
  loadToken,
  saveToken,
} from "@/lib/git/tokenStorage";
import {
  canAccessRepository,
  createGitHubClient,
  fetchAccount,
  type GitHubAccount,
  type GitHubClient,
} from "@/lib/git/github";
import type { GitRemoteConfig } from "@/lib/git/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GitHubRemotePanelProps {
  /** The remote the workspace is linked to. */
  remote: GitRemoteConfig | null;
  /** Fired when the remote is connected or cleared. */
  onRemoteChange: (remote: GitRemoteConfig | null) => void;
  /** Branch that is pushed / pulled. */
  branch: string;
  /** Push the current branch. */
  onPush?: (client: GitHubClient, remote: GitRemoteConfig) => Promise<void>;
  /** Pull the current branch. */
  onPull?: (client: GitHubClient, remote: GitRemoteConfig) => Promise<void>;
  /** `true` while a push/pull is running. */
  busy?: boolean;
}

// ---------------------------------------------------------------------------
// GitHubRemotePanel
// ---------------------------------------------------------------------------

const GitHubRemotePanel: React.FC<GitHubRemotePanelProps> = ({
  remote,
  onRemoteChange,
  branch,
  onPush,
  onPull,
  busy = false,
}) => {
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState(remote?.owner ?? "");
  const [repo, setRepo] = useState(remote?.repo ?? "");
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  // Restore the session on mount — the token itself is never rendered.
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const info = getTokenInfo();
      if (!info.present) return;
      try {
        const stored = await loadToken();
        if (!stored || cancelled) return;
        const client = await createGitHubClient(stored);
        const profile = await fetchAccount(client);
        if (cancelled) return;
        setAccount(profile);
        setStatus(`Authenticated as ${profile.login}.`);
      } catch {
        if (!cancelled) {
          setStatus(null);
        }
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof remote?.owner === "string") {
      setOwner(remote.owner);
    }
    if (typeof remote?.repo === "string") {
      setRepo(remote.repo);
    }
  }, [remote?.owner, remote?.repo]);

  const handleSaveToken = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      await saveToken(token);
      setToken("");
      const client = await createGitHubClient(token.trim());
      const profile = await fetchAccount(client);
      setAccount(profile);
      setStatus(`Token saved. Authenticated as ${profile.login}.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The GitHub token could not be stored.",
      );
    }
  }, [token]);

  const handleForgetToken = useCallback(() => {
    clearToken();
    setAccount(null);
    setStatus("The stored token was removed.");
    setError(null);
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    setStatus(null);

    const trimmedOwner = owner.trim();
    const trimmedRepo = repo.trim();
    if (!trimmedOwner || !trimmedRepo) {
      setError("Both the owner and the repository name are required.");
      return;
    }

    const stored = await loadToken();
    if (!stored) {
      setError("Store a GitHub personal access token first.");
      return;
    }

    setIsWorking(true);
    try {
      const client = await createGitHubClient(stored);
      const allowed = await canAccessRepository(client, {
        owner: trimmedOwner,
        repo: trimmedRepo,
        name: "origin",
      });
      if (!allowed) {
        setError(
          `The token cannot access ${trimmedOwner}/${trimmedRepo}. Check the repository permissions.`,
        );
        return;
      }
      onRemoteChange({
        owner: trimmedOwner,
        repo: trimmedRepo,
        name: "origin",
      });
      setStatus(`Connected to ${trimmedOwner}/${trimmedRepo}.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The GitHub repository could not be reached.",
      );
    } finally {
      setIsWorking(false);
    }
  }, [owner, repo, onRemoteChange]);

  const handlePush = useCallback(async () => {
    if (!remote || !onPush) return;
    setError(null);
    setStatus(null);
    setIsWorking(true);
    try {
      const stored = await loadToken();
      if (!stored) {
        setError("Store a GitHub personal access token first.");
        return;
      }
      const client = await createGitHubClient(stored);
      await onPush(client, remote);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The push failed.",
      );
    } finally {
      setIsWorking(false);
    }
  }, [remote, onPush]);

  const handlePull = useCallback(async () => {
    if (!remote || !onPull) return;
    setError(null);
    setStatus(null);
    setIsWorking(true);
    try {
      const stored = await loadToken();
      if (!stored) {
        setError("Store a GitHub personal access token first.");
        return;
      }
      const client = await createGitHubClient(stored);
      await onPull(client, remote);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The pull failed.",
      );
    } finally {
      setIsWorking(false);
    }
  }, [remote, onPull]);

  const working = busy || isWorking;

  return (
    <section
      data-testid="github-remote-panel"
      className="rounded-2xl border border-white/8 bg-white/5 p-4"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
          <svg
            viewBox="0 0 16 16"
            width={14}
            height={14}
            aria-hidden="true"
            fill="currentColor"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub Remote
        </p>
        {account ? (
          <span
            data-testid="github-account"
            className="flex items-center gap-2 text-xs text-emerald-300"
          >
            {account.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={account.avatarUrl}
                alt=""
                width={18}
                height={18}
                className="h-[18px] w-[18px] rounded-full"
              />
            ) : null}
            {account.login}
          </span>
        ) : (
          <span className="text-xs text-slate-500">Not connected</span>
        )}
      </header>

      <div className="space-y-3">
        <div>
          <label
            htmlFor="github-token-input"
            className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400"
          >
            <KeyRound size={11} />
            Personal access token
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="github-token-input"
              data-testid="github-token-input"
              type="password"
              value={token}
              placeholder="github_pat_…"
              onChange={(event) => setToken(event.target.value)}
              className="min-w-[200px] flex-1 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-teal-400/50"
            />
            <button
              type="button"
              data-testid="github-token-save"
              onClick={() => void handleSaveToken()}
              disabled={token.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded-full border border-teal-400/30 bg-teal-400/10 px-3 py-1.5 text-xs font-medium text-teal-200 transition hover:bg-teal-400/20 disabled:opacity-40"
            >
              Save token
            </button>
            <button
              type="button"
              data-testid="github-token-clear"
              onClick={handleForgetToken}
              aria-label="Remove the stored GitHub token"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-rose-400/40 hover:text-rose-200"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            The token is encrypted with AES-GCM before it is written to the
            browser storage.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label
              htmlFor="github-owner-input"
              className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400"
            >
              Owner
            </label>
            <input
              id="github-owner-input"
              data-testid="github-owner-input"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder="StellarDevHub"
              className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-teal-400/50"
            />
          </div>
          <div>
            <label
              htmlFor="github-repo-input"
              className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400"
            >
              Repository
            </label>
            <input
              id="github-repo-input"
              data-testid="github-repo-input"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="soroban-playground"
              className="w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-1.5 font-mono text-xs text-slate-200 outline-none focus:border-teal-400/50"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="github-connect"
            onClick={() => void handleConnect()}
            disabled={working}
            className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
          >
            {working ? <LoaderCircle size={13} className="animate-spin" /> : null}
            Connect
          </button>
          <button
            type="button"
            data-testid="github-push"
            onClick={() => void handlePush()}
            disabled={!remote || !onPush || working}
            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-400/20 disabled:opacity-40"
          >
            <CloudUpload size={13} />
            Push {branch}
          </button>
          <button
            type="button"
            data-testid="github-pull"
            onClick={() => void handlePull()}
            disabled={!remote || !onPull || working}
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-40"
          >
            <CloudDownload size={13} />
            Pull {branch}
          </button>
        </div>

        {status && (
          <p
            data-testid="github-status"
            className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-200"
          >
            {status}
          </p>
        )}
        {error && (
          <p
            data-testid="github-error"
            className="rounded-lg border border-rose-400/25 bg-rose-400/5 px-3 py-2 text-xs text-rose-200"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
};

export default GitHubRemotePanel;

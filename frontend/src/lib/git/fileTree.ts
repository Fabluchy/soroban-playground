// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Helpers that turn the flat file list of the Git engine into the nested
 * structure the file explorer renders (issue #1727 / FE-27).
 */

import type { FileTreeNode } from "@/components/FileTree";
import type { GitFileStatus, GitFileStatusEntry } from "./types";

/** Short badge shown next to a file in the explorer. */
const STATUS_BADGES: Record<GitFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  conflicted: "U",
  clean: "",
};

/**
 * Build the nested explorer nodes for a set of paths.
 *
 * `statuses` carries the per-file Git status; paths without an entry are
 * rendered as clean files.
 */
export function buildFileTreeNodes(
  paths: string[],
  statuses: GitFileStatusEntry[] = [],
): FileTreeNode[] {
  const statusByPath = new Map(statuses.map((entry) => [entry.path, entry]));

  interface MutableNode {
    id: string;
    name: string;
    type: "file" | "folder";
    children: Map<string, MutableNode>;
    dirty: boolean;
    status: string | undefined;
  }

  const roots = new Map<string, MutableNode>();

  const ensureFolder = (
    parent: Map<string, MutableNode>,
    name: string,
    id: string,
  ): MutableNode => {
    const existing = parent.get(name);
    if (existing) return existing;
    const node: MutableNode = {
      id,
      name,
      type: "folder",
      children: new Map(),
      dirty: false,
      status: undefined,
    };
    parent.set(name, node);
    return node;
  };

  for (const path of [...paths].sort()) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let parent = roots;
    let prefix = "";

    segments.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const isFile = index === segments.length - 1;

      if (isFile) {
        const entry = statusByPath.get(path);
        parent.set(segment, {
          id: path,
          name: segment,
          type: "file",
          children: new Map(),
          dirty: Boolean(entry && entry.status !== "clean"),
          status: entry ? STATUS_BADGES[entry.status] : undefined,
        });
        return;
      }

      const folder = ensureFolder(parent, segment, prefix);
      parent = folder.children;
    });
  }

  const toNode = (node: MutableNode): FileTreeNode => ({
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.status ? { status: node.status } : {}),
    ...(node.dirty ? { dirty: true } : {}),
    ...(node.children.size > 0
      ? {
          children: Array.from(node.children.values())
            .map(toNode)
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
              return a.name.localeCompare(b.name);
            }),
        }
      : {}),
  });

  return Array.from(roots.values())
    .map(toNode)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

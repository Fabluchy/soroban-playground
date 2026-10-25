"use client";

/**
 * FileTree – a recursive, memoized file-explorer component for the Soroban
 * Playground IDE.
 *
 * Design goals (Issue #923):
 *  - Clean, strongly-typed public API via exported interfaces.
 *  - Memoized sub-components so only the affected subtree re-renders on state
 *    changes (open/close toggle, active-file selection).
 *  - Keyboard-accessible: Enter / Space toggle folders; all interactive
 *    elements have explicit aria-* attributes.
 *  - Zero external styling dependencies beyond Tailwind utility classes that
 *    already exist in the project's design system.
 *  - Backwards-compatible: the `FileTreeNode` shape is a strict superset of
 *    what callers previously passed inline, so existing render sites need no
 *    changes.
 */

import React, {
  KeyboardEvent,
  memo,
  useCallback,
  useId,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode,
  FileJson,
  FileLock,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single node in the file tree — either a file leaf or a folder. */
export interface FileTreeNode {
  /** Unique, stable identifier (e.g. a relative path). */
  id: string;
  /** Display label shown in the UI. */
  name: string;
  /** `"file"` for leaf nodes; `"folder"` for containers. */
  type: "file" | "folder";
  /** Child nodes (only meaningful when `type === "folder"`). */
  children?: FileTreeNode[];
  /**
   * Optional file extension hint used to pick an icon.
   * If omitted the extension is inferred from `name`.
   */
  extension?: string;
  /**
   * Marks the file as having uncommitted changes (issue #1727).
   * The explorer renders a live status marker next to the file name.
   */
  dirty?: boolean;
  /**
   * Optional short status badge, e.g. `"M"`, `"A"` or `"D"`.
   * Defaults to `"M"` when `dirty` is set.
   */
  status?: string;
}

export interface FileTreeProps {
  /** Root-level nodes to render. */
  nodes: FileTreeNode[];
  /**
   * The `id` of the currently selected file node.
   * Pass `null` / `undefined` when nothing is selected.
   */
  activeNodeId?: string | null;
  /**
   * Fired when the user clicks (or presses Enter / Space) on a file node.
   * Folder nodes toggle open/closed without firing this callback.
   */
  onSelectFile?: (node: FileTreeNode) => void;
  /**
   * Optional CSS class applied to the outermost `<ul>` element.
   * Use this to control height, overflow, etc. from the call site.
   */
  className?: string;
  /**
   * Text shown when `nodes` is empty.
   * Defaults to `"No files found."`.
   */
  emptyText?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the portion after the last `.`, lower-cased, or empty string. */
function getExtension(name: string, hint?: string): string {
  if (hint) return hint.toLowerCase().replace(/^\./, "");
  const dot = name.lastIndexOf(".");
  return dot !== -1 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Map a file extension to a Lucide icon component. */
function resolveFileIcon(
  ext: string,
): React.ComponentType<{ className?: string; size?: number }> {
  switch (ext) {
    case "rs":
      return FileCode;
    case "json":
    case "toml":
    case "yaml":
    case "yml":
      return FileJson;
    case "md":
    case "txt":
      return FileText;
    case "lock":
      return FileLock;
    default:
      return File;
  }
}

// ---------------------------------------------------------------------------
// FileNode — a single row (file leaf)
// ---------------------------------------------------------------------------

interface FileNodeProps {
  node: FileTreeNode;
  depth: number;
  isActive: boolean;
  onSelect: (node: FileTreeNode) => void;
  treeId: string;
}

const FileNode = memo(function FileNode({
  node,
  depth,
  isActive,
  onSelect,
  treeId,
}: FileNodeProps) {
  const ext = getExtension(node.name, node.extension);
  const Icon = resolveFileIcon(ext);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLLIElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(node);
      }
    },
    [node, onSelect],
  );

  return (
    <li
      id={`${treeId}-node-${node.id}`}
      role="treeitem"
      aria-selected={isActive}
      tabIndex={0}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      className={[
        "group flex items-center gap-2 py-1 pr-3 rounded-lg cursor-pointer",
        "text-xs font-medium select-none outline-none",
        "transition-colors duration-100",
        isActive
          ? "bg-teal-500/15 border border-teal-500/25 text-teal-300"
          : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.03] border border-transparent",
        "focus-visible:ring-1 focus-visible:ring-teal-400/60",
      ].join(" ")}
      onClick={() => onSelect(node)}
      onKeyDown={handleKeyDown}
      aria-label={node.name}
    >
      <Icon
        size={13}
        className={[
          "shrink-0 transition-colors",
          isActive
            ? "text-teal-400"
            : "text-slate-500 group-hover:text-slate-300",
        ].join(" ")}
      />
      <span className="truncate">{node.name}</span>
      {node.dirty && (
        <span
          data-testid="filetree-dirty"
          title="Uncommitted changes"
          aria-label={`Uncommitted changes in ${node.name}`}
          className="ml-auto shrink-0 rounded bg-amber-400/15 px-1 font-mono text-[9px] font-semibold text-amber-300"
        >
          {node.status ?? "M"}
        </span>
      )}
      {ext && (
        <span
          className={[
            "font-mono text-[9px] text-slate-600 group-hover:text-slate-500 shrink-0",
            node.dirty ? "ml-1" : "ml-auto",
          ].join(" ")}
        >
          .{ext}
        </span>
      )}
    </li>
  );
});

// ---------------------------------------------------------------------------
// FolderNode — a collapsible row with children
// ---------------------------------------------------------------------------

interface FolderNodeProps {
  node: FileTreeNode;
  depth: number;
  activeNodeId: string | null | undefined;
  onSelect: (node: FileTreeNode) => void;
  treeId: string;
  /** Whether the folder starts open. */
  defaultOpen?: boolean;
}

const FolderNode = memo(function FolderNode({
  node,
  depth,
  activeNodeId,
  onSelect,
  treeId,
  defaultOpen = false,
}: FolderNodeProps) {
  const [open, setOpen] = useState(defaultOpen);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLLIElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  const FolderIcon = open ? FolderOpen : Folder;
  const ChevronIcon = open ? ChevronDown : ChevronRight;

  return (
    <li
      id={`${treeId}-node-${node.id}`}
      role="treeitem"
      aria-expanded={open}
      aria-label={node.name}
      tabIndex={0}
      className={[
        "select-none outline-none",
        "focus-visible:ring-1 focus-visible:ring-teal-400/60 rounded-lg",
      ].join(" ")}
      onKeyDown={handleKeyDown}
    >
      {/* Header row */}
      <div
        role="button"
        tabIndex={-1}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={[
          "group flex items-center gap-2 py-1 pr-3 rounded-lg cursor-pointer",
          "text-xs font-semibold text-slate-400 hover:text-slate-200",
          "hover:bg-white/[0.03] border border-transparent transition-colors",
        ].join(" ")}
        onClick={toggle}
        aria-hidden // the parent <li> handles keyboard events
      >
        <ChevronIcon
          size={11}
          className="shrink-0 text-slate-600 group-hover:text-slate-400 transition-transform"
        />
        <FolderIcon
          size={13}
          className={[
            "shrink-0 transition-colors",
            open
              ? "text-teal-400/80"
              : "text-slate-500 group-hover:text-slate-300",
          ].join(" ")}
        />
        <span className="truncate">{node.name}</span>
        {node.children !== undefined && (
          <span className="ml-auto font-mono text-[9px] text-slate-600 shrink-0">
            {node.children.length}
          </span>
        )}
      </div>

      {/* Children */}
      {open && node.children && node.children.length > 0 && (
        <ul role="group" className="mt-0.5 space-y-0.5">
          {node.children.map((child) =>
            child.type === "folder" ? (
              <FolderNode
                key={child.id}
                node={child}
                depth={depth + 1}
                activeNodeId={activeNodeId}
                onSelect={onSelect}
                treeId={treeId}
              />
            ) : (
              <FileNode
                key={child.id}
                node={child}
                depth={depth + 1}
                isActive={activeNodeId === child.id}
                onSelect={onSelect}
                treeId={treeId}
              />
            ),
          )}
        </ul>
      )}
    </li>
  );
});

// ---------------------------------------------------------------------------
// FileTree — public component
// ---------------------------------------------------------------------------

/**
 * Renders a recursive file-explorer tree.
 *
 * @example
 * ```tsx
 * const nodes: FileTreeNode[] = [
 *   { id: "src", name: "src", type: "folder", children: [
 *     { id: "src/lib.rs", name: "lib.rs", type: "file" },
 *   ]},
 *   { id: "Cargo.toml", name: "Cargo.toml", type: "file" },
 * ];
 *
 * <FileTree
 *   nodes={nodes}
 *   activeNodeId={selectedId}
 *   onSelectFile={(node) => setSelectedId(node.id)}
 * />
 * ```
 */
const FileTree: React.FC<FileTreeProps> = ({
  nodes,
  activeNodeId,
  onSelectFile,
  className = "",
  emptyText = "No files found.",
}) => {
  // Stable ID prefix so multiple FileTree instances on a page don't conflict.
  const treeId = useId();

  const handleSelect = useCallback(
    (node: FileTreeNode) => {
      onSelectFile?.(node);
    },
    [onSelectFile],
  );

  if (nodes.length === 0) {
    return (
      <p
        className="py-8 text-center text-xs text-slate-500"
        aria-live="polite"
        data-testid="filetree-empty"
      >
        {emptyText}
      </p>
    );
  }

  return (
    <ul
      role="tree"
      aria-label="File explorer"
      className={["space-y-0.5 font-sans text-xs", className].join(" ")}
      data-testid="filetree-root"
    >
      {nodes.map((node) =>
        node.type === "folder" ? (
          <FolderNode
            key={node.id}
            node={node}
            depth={0}
            activeNodeId={activeNodeId}
            onSelect={handleSelect}
            treeId={treeId}
            defaultOpen
          />
        ) : (
          <FileNode
            key={node.id}
            node={node}
            depth={0}
            isActive={activeNodeId === node.id}
            onSelect={handleSelect}
            treeId={treeId}
          />
        ),
      )}
    </ul>
  );
};

export default FileTree;

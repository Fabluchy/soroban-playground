"use client";

/**
 * CommitGraph – an SVG visualisation of the in-app Git history
 * (issue #1727 / FE-27).
 *
 * The graph mirrors the way Git draws its own log: every commit lives in a
 * *lane*, the first parent continues the lane of its child and additional
 * parents (merge commits) open a new lane. Author avatars and the commit
 * message are rendered next to every node.
 */

import React, { useCallback, useMemo } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { CommitGraph as CommitGraphModel } from "@/lib/git/types";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Horizontal distance between two lanes, in pixels. */
const LANE_WIDTH = 22;
/** Vertical distance between two commits, in pixels. */
const ROW_HEIGHT = 46;
/** Padding around the graph area, in pixels. */
const PADDING = 14;
/** Width reserved for the message column, in pixels. */
const MESSAGE_WIDTH = 360;
/** Radius of a commit node, in pixels. */
const NODE_RADIUS = 6;

/** Colour used for every lane. */
const LANE_COLOR = "#2dd4bf";
/** Colour used for the lane of the checked-out branch. */
const HEAD_LANE_COLOR = "#38bdf8";
/** Colour used for branch labels. */
const BRANCH_COLOR = "#a78bfa";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommitGraphProps {
  /** The graph produced by `getCommitGraph`. */
  graph: CommitGraphModel;
  /** Fired when a commit node is activated. */
  onSelectCommit?: (commitId: string) => void;
  /** Commit id that is currently highlighted. */
  selectedCommitId?: string | null;
  /** Maximum number of commits that are rendered. */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a timestamp as a short, human readable string. */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** First letters of an author name, used when no avatar is available. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/** Truncate a commit message so it fits into the message column. */
function truncate(message: string, max = 58): string {
  const single = message.split("\n")[0];
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// CommitGraph
// ---------------------------------------------------------------------------

const CommitGraph: React.FC<CommitGraphProps> = ({
  graph,
  onSelectCommit,
  selectedCommitId = null,
  maxRows = 40,
}) => {
  const nodes = useMemo(
    () => graph.nodes.slice(0, maxRows),
    [graph.nodes, maxRows],
  );

  const visibleIds = useMemo(
    () => new Set(nodes.map((node) => node.id)),
    [nodes],
  );

  const edges = useMemo(
    () => graph.edges.filter((edge) => visibleIds.has(edge.to)),
    [graph.edges, visibleIds],
  );

  const laneX = useCallback(
    (lane: number) => PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2,
    [],
  );

  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  if (nodes.length === 0) {
    return (
      <div
        data-testid="commit-graph-empty"
        className="flex items-center gap-2 rounded-xl border border-white/8 bg-slate-950/50 px-3 py-6 text-xs text-slate-500"
      >
        <GitCommitHorizontal size={14} />
        No commits yet — commit your changes to start the history.
      </div>
    );
  }

  const graphWidth = PADDING * 2 + graph.laneCount * LANE_WIDTH;
  const height = nodes.length * ROW_HEIGHT;
  const totalWidth = graphWidth + MESSAGE_WIDTH;

  return (
    <div
      data-testid="commit-graph"
      role="region"
      aria-label="Commit history"
      tabIndex={0}
      className="overflow-x-auto rounded-xl border border-white/8 bg-slate-950/60"
    >
      <svg
        role="img"
        aria-label="Commit history graph"
        viewBox={`0 0 ${totalWidth} ${height}`}
        width="100%"
        height={height}
        className="min-w-[520px]"
      >
        <defs>
          <clipPath id="commit-avatar-clip">
            <circle cx="0" cy="0" r="9" />
          </clipPath>
        </defs>

        {/* Edges */}
        {edges.map((edge) => {
          const child = nodeById.get(edge.to);
          const parent = nodeById.get(edge.from);
          if (!child || !parent) return null;

          const cx = laneX(child.lane);
          const cy = child.row * ROW_HEIGHT + ROW_HEIGHT / 2;
          const px = laneX(parent.lane);
          const py = parent.row * ROW_HEIGHT + ROW_HEIGHT / 2;
          const dy = py - cy;

          return (
            <path
              key={`${edge.from}->${edge.to}`}
              data-testid="commit-graph-edge"
              d={`M ${cx} ${cy} C ${cx} ${cy + dy * 0.5}, ${px} ${py - dy * 0.5}, ${px} ${py}`}
              fill="none"
              stroke={child.isHead ? HEAD_LANE_COLOR : LANE_COLOR}
              strokeOpacity={0.65}
              strokeWidth={2}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const cx = laneX(node.lane);
          const textX = graphWidth + 4;
          const isSelected = node.id === selectedCommitId;

          return (
            <g
              key={node.id}
              data-testid="commit-graph-node"
              data-commit-id={node.id}
              data-lane={node.lane}
              transform={`translate(0, ${node.row * ROW_HEIGHT})`}
              onClick={() => onSelectCommit?.(node.id)}
              style={{ cursor: onSelectCommit ? "pointer" : "default" }}
            >
              {/* Hit area for the whole row */}
              <rect
                x={0}
                y={0}
                width={totalWidth}
                height={ROW_HEIGHT}
                fill={isSelected ? "rgba(45,212,191,0.08)" : "transparent"}
              />

              {/* Lane line passing through the node */}
              <line
                x1={cx}
                y1={0}
                x2={cx}
                y2={ROW_HEIGHT}
                stroke={node.isHead ? HEAD_LANE_COLOR : LANE_COLOR}
                strokeOpacity={0.25}
                strokeWidth={1}
              />

              {/* Node */}
              <circle
                cx={cx}
                cy={ROW_HEIGHT / 2}
                r={NODE_RADIUS}
                fill={node.isMerge ? BRANCH_COLOR : LANE_COLOR}
                stroke="#020617"
                strokeWidth={2}
              />
              {node.isHead && (
                <circle
                  cx={cx}
                  cy={ROW_HEIGHT / 2}
                  r={NODE_RADIUS + 4}
                  fill="none"
                  stroke={HEAD_LANE_COLOR}
                  strokeWidth={1.5}
                  strokeOpacity={0.8}
                />
              )}

              {/* Avatar */}
              <g transform={`translate(${graphWidth - 22}, ${ROW_HEIGHT / 2})`}>
                {node.author.avatarUrl ? (
                  <image
                    href={node.author.avatarUrl}
                    x={-9}
                    y={-9}
                    width={18}
                    height={18}
                    clipPath="url(#commit-avatar-clip)"
                    preserveAspectRatio="xMidYMid slice"
                    data-testid="commit-graph-avatar"
                  />
                ) : (
                  <>
                    <circle cx={0} cy={0} r={9} fill="rgba(148,163,184,0.25)" />
                    <text
                      x={0}
                      y={3}
                      textAnchor="middle"
                      fontSize={8}
                      fill="#cbd5e1"
                      data-testid="commit-graph-avatar-fallback"
                    >
                      {initialsOf(node.author.name)}
                    </text>
                  </>
                )}
              </g>

              {/* Message + meta */}
              <text
                x={textX}
                y={20}
                fontSize={11}
                fill="#e2e8f0"
                data-testid="commit-graph-message"
              >
                {truncate(node.message)}
              </text>
              <text x={textX} y={34} fontSize={9} fill="#64748b">
                {node.author.name} · {formatTimestamp(node.timestamp)}
                {node.isPushed ? " · pushed" : ""}
              </text>

              {/* Branch labels */}
              {node.branchNames.map((branch, index) => {
                const labelWidth = Math.max(34, branch.length * 6 + 12);
                const bx = textX + index * (labelWidth + 6);
                const by = 38;
                return (
                  <g
                    key={`${node.id}-${branch}`}
                    data-testid="commit-graph-branch"
                  >
                    <rect
                      x={bx}
                      y={by}
                      width={labelWidth}
                      height={14}
                      rx={7}
                      fill="rgba(167,139,250,0.18)"
                      stroke="rgba(167,139,250,0.5)"
                    />
                    <text
                      x={bx + labelWidth / 2}
                      y={by + 9.5}
                      textAnchor="middle"
                      fontSize={9}
                      fill="rgb(216,180,254)"
                    >
                      {branch}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export default CommitGraph;

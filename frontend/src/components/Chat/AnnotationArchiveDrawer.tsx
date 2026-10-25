"use client";
import { useRef } from "react";
import { useModalAccessibility } from "@/accessibility/useModalAccessibility";
import type { AnnotationThread } from "@/lib/annotations/yjsAnnotations";
import { MarkdownComment } from "./MarkdownComment";

export function AnnotationArchiveDrawer({
  open,
  threads,
  onReopen,
  onDelete,
  onClose,
  mentions,
}: {
  open: boolean;
  threads: AnnotationThread[];
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  mentions?: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalAccessibility(ref, open, onClose);
  if (!open) return null;
  const archived = threads.filter((thread) => thread.resolved);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby="annotation-archive-title"
      tabIndex={-1}
      className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-slate-700 bg-slate-950 p-5 text-slate-100"
    >
      <h2 id="annotation-archive-title">Resolved annotations</h2>
      <button type="button" onClick={onClose}>
        Close archive
      </button>
      {archived.length === 0 ? (
        <p>No resolved annotations.</p>
      ) : (
        <ul>
          {archived.map((thread) => (
            <li key={thread.id}>
              <h3>
                Line {thread.line + 1}: {thread.authorName}
              </h3>
              <MarkdownComment content={thread.body} mentions={mentions} />
              <button type="button" onClick={() => onReopen(thread.id)}>
                Reopen annotation
              </button>
              <button type="button" onClick={() => onDelete(thread.id)}>
                Delete annotation
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

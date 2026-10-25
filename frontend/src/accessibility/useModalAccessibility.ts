"use client";

import { useEffect, useRef, type RefObject } from "react";
import { createFocusTrap } from "@/lib/accessibility";

export function useModalAccessibility(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose?: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const container = ref.current;
    if (!open || !container) return;
    const trap = createFocusTrap(container);
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        container.contains(document.activeElement) &&
        close.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
    };
    container.addEventListener("keydown", escape);
    return () => {
      container.removeEventListener("keydown", escape);
      trap.release();
    };
  }, [open, ref]);
}

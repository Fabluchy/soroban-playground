export type Politeness = "polite" | "assertive";

/** Stable regions keep urgency consistent for assistive technology. */
export class LiveRegionManager {
  private queues = new Map<Politeness, string[]>();
  private active = new Set<Politeness>();
  announce(message: string, politeness: Politeness = "polite"): void {
    if (typeof document === "undefined" || !message.trim()) return;
    const queue = this.queues.get(politeness) || [];
    if (queue[queue.length - 1] !== message) queue.push(message);
    this.queues.set(politeness, queue.slice(-20));
    this.flush(politeness);
  }
  private flush(politeness: Politeness) {
    if (this.active.has(politeness)) return;
    const message = this.queues.get(politeness)?.shift();
    if (!message) return;
    const id =
      politeness === "polite"
        ? "a11y-live-region"
        : "a11y-live-region-assertive";
    let region = document.getElementById(id);
    if (!region) {
      region = document.createElement("div");
      region.id = id;
      region.className = "sr-only";
      region.setAttribute("role", politeness === "polite" ? "status" : "alert");
      region.setAttribute("aria-live", politeness);
      region.setAttribute("aria-atomic", "true");
      document.body.appendChild(region);
    }
    this.active.add(politeness);
    region.textContent = "";
    const target = region;
    setTimeout(() => {
      if (target.isConnected) target.textContent = message;
      setTimeout(() => {
        this.active.delete(politeness);
        this.flush(politeness);
      }, 1000);
    }, 50);
  }
}
export const liveRegionManager = new LiveRegionManager();
export function announceToScreenReader(
  message: string,
  politeness: Politeness = "polite",
): void {
  liveRegionManager.announce(message, politeness);
}

const traps: HTMLElement[] = [];
const inertCounts = new WeakMap<
  HTMLElement,
  { count: number; original: boolean }
>();
function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,[contenteditable="true"],[tabindex]',
    ),
  ).filter((element) => {
    if (
      element.tabIndex < 0 ||
      element.matches(':disabled,input[type="hidden"]') ||
      element.closest('[hidden],[inert],[aria-hidden="true"]')
    )
      return false;
    let current: HTMLElement | null = element;
    while (current) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      current = current.parentElement;
    }
    return true;
  });
}

/** Dynamic nested-modal containment, background isolation and focus restoration. */
export function createFocusTrap(container: HTMLElement): {
  release: () => void;
} {
  const previous =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const oldTabIndex = container.getAttribute("tabindex");
  if (oldTabIndex === null) container.tabIndex = -1;
  const isolated: HTMLElement[] = [];
  let branch: HTMLElement = container;
  while (branch.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (
        !(sibling instanceof HTMLElement) ||
        sibling === branch ||
        sibling.matches("[aria-live],script,style,link")
      )
        continue;
      const entry = inertCounts.get(sibling) || {
        count: 0,
        original: sibling.hasAttribute("inert"),
      };
      entry.count++;
      inertCounts.set(sibling, entry);
      sibling.setAttribute("inert", "");
      isolated.push(sibling);
    }
    if (branch.parentElement === document.body) break;
    branch = branch.parentElement;
  }
  traps.push(container);
  const isTop = () => traps[traps.length - 1] === container;
  const initial = () => focusable(container)[0] || container;
  initial().focus();
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isTop() || event.key !== "Tab") return;
    const items = focusable(container);
    const first = items[0] || container;
    const last = items[items.length - 1] || container;
    if (
      !items.length ||
      !container.contains(document.activeElement) ||
      (event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last) ||
      document.activeElement === container
    ) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  const containFocus = (event: FocusEvent) => {
    if (isTop() && !container.contains(event.target as Node)) initial().focus();
  };
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("focusin", containFocus);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", containFocus);
      const index = traps.lastIndexOf(container);
      const wasTop = isTop();
      if (index >= 0) traps.splice(index, 1);
      for (const element of isolated) {
        const entry = inertCounts.get(element);
        if (!entry) continue;
        if (--entry.count === 0) {
          if (!entry.original) element.removeAttribute("inert");
          inertCounts.delete(element);
        }
      }
      if (oldTabIndex === null) container.removeAttribute("tabindex");
      else container.setAttribute("tabindex", oldTabIndex);
      if (wasTop) {
        if (previous?.isConnected && !previous.closest("[inert]"))
          previous.focus();
        else if (traps.length)
          (
            focusable(traps[traps.length - 1])[0] || traps[traps.length - 1]
          ).focus();
      }
    },
  };
}

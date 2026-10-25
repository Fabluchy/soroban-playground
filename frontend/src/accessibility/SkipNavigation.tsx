"use client";

import { useSyncExternalStore } from "react";

const destinations = [
  ["main-content", "Skip to main content"],
  ["workspace-editor", "Skip to editor"],
  ["workspace-console", "Skip to console"],
  ["primary-navigation", "Skip to navigation"],
];
const snapshot = () =>
  destinations
    .filter(([id]) => document.getElementById(id))
    .map(([id]) => id)
    .join(",");
const subscribe = (changed: () => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["id"],
  });
  return () => observer.disconnect();
};

/** Plain anchors work before hydration; mounted handlers explicitly move focus. */
export function SkipNavigation() {
  const mounted = useSyncExternalStore(
    subscribe,
    snapshot,
    () => "main-content,primary-navigation",
  );
  return (
    <nav aria-label="Skip navigation" className="skip-navigation">
      {destinations
        .filter(([target]) => mounted.split(",").includes(target))
        .map(([target, label]) => (
          <a
            key={target}
            href={`#${target}`}
            onClick={(event) => {
              const preferred = document.getElementById(target);
              const element =
                target === "primary-navigation" &&
                preferred &&
                getComputedStyle(preferred).display === "none"
                  ? document.getElementById("primary-navigation-mobile")
                  : preferred || document.getElementById("main-content");
              if (element) {
                event.preventDefault();
                element.focus();
                element.scrollIntoView({ block: "nearest" });
              }
            }}
          >
            {label}
          </a>
        ))}
    </nav>
  );
}

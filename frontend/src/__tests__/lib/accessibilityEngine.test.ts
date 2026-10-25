import { createFocusTrap, LiveRegionManager } from "@/lib/accessibility";

let releases: (() => void)[];
beforeEach(() => {
  document.body.innerHTML = "";
  releases = [];
  jest.useFakeTimers();
});
afterEach(() => {
  releases.reverse().forEach((release) => release());
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});
function trap(element: HTMLElement) {
  const handle = createFocusTrap(element);
  releases.push(handle.release);
  return handle;
}
function tab(shiftKey = false) {
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

test("announces queued messages in stable polite and assertive regions without duplicates", () => {
  const manager = new LiveRegionManager();
  manager.announce("Build started");
  manager.announce("Build complete");
  manager.announce("Deploy failed", "assertive");
  jest.advanceTimersByTime(50);
  expect(document.getElementById("a11y-live-region")).toHaveTextContent(
    "Build started",
  );
  expect(
    document.getElementById("a11y-live-region-assertive"),
  ).toHaveTextContent("Deploy failed");
  jest.advanceTimersByTime(1050);
  expect(document.getElementById("a11y-live-region")).toHaveTextContent(
    "Build complete",
  );
  expect(document.querySelectorAll("#a11y-live-region")).toHaveLength(1);
});
test("ignores blank announcements", () => {
  new LiveRegionManager().announce("  ");
  expect(document.querySelector("[aria-live]")).toBeNull();
});
test("skips hidden/disabled elements and includes dynamically added controls in both tab directions", () => {
  document.body.innerHTML =
    '<section id="modal"><button hidden>Hidden</button><button disabled>Disabled</button><button id="first">First</button><button id="last">Last</button></section>';
  const modal = document.getElementById("modal")!;
  trap(modal);
  expect(document.activeElement?.id).toBe("first");
  const button = document.createElement("button");
  button.id = "dynamic";
  modal.appendChild(button);
  button.focus();
  tab();
  expect(document.activeElement?.id).toBe("first");
  tab(true);
  expect(document.activeElement?.id).toBe("dynamic");
});
test("contains programmatic focus, isolates background, and restores the original trigger", () => {
  document.body.innerHTML =
    '<button id="trigger">Open</button><section id="modal"><button id="inside">Inside</button></section>';
  const trigger = document.getElementById("trigger")!;
  trigger.focus();
  const handle = trap(document.getElementById("modal")!);
  expect(trigger).toHaveAttribute("inert");
  trigger.focus();
  expect(document.activeElement?.id).toBe("inside");
  handle.release();
  expect(trigger).not.toHaveAttribute("inert");
  expect(document.activeElement).toBe(trigger);
});
test("empty dialogs retain focus and release restores existing tabindex", () => {
  document.body.innerHTML = '<section id="modal" tabindex="-1"></section>';
  const modal = document.getElementById("modal")!;
  const handle = trap(modal);
  tab();
  expect(document.activeElement).toBe(modal);
  handle.release();
  expect(modal).toHaveAttribute("tabindex", "-1");
});
test("nested traps restore the outer dialog and preserve pre-existing inert state", () => {
  document.body.innerHTML =
    '<button id="trigger">Open</button><div id="old" inert>Already inert</div><section id="outer"><button id="outer-button">Inner</button><section id="inner" hidden><button id="inner-button">Close</button></section></section>';
  const trigger = document.getElementById("trigger")!;
  trigger.focus();
  const outer = trap(document.getElementById("outer")!);
  const innerElement = document.getElementById("inner")!;
  innerElement.removeAttribute("hidden");
  const inner = trap(innerElement);
  expect(document.activeElement?.id).toBe("inner-button");
  inner.release();
  expect(document.activeElement?.id).toBe("outer-button");
  outer.release();
  expect(document.activeElement).toBe(trigger);
  expect(document.getElementById("old")).toHaveAttribute("inert");
});

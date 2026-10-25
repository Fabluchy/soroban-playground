import React, { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import DeployPanel from "@/components/DeployPanel";
import { SkipNavigation } from "@/accessibility/SkipNavigation";
import { ScreenReaderAnnouncer } from "@/accessibility/ScreenReaderAnnouncer";
import { useModalAccessibility } from "@/accessibility/useModalAccessibility";
import { ConsoleAndEventsDrawer } from "@/components/ConsoleAndEventsDrawer";

jest.mock("next/navigation", () => ({ usePathname: () => "/" }));

jest.mock("@/components/Console", () => ({
  __esModule: true,
  default: () => <div>Console pane</div>,
}));
jest.mock("@/components/EventsPanel", () => ({
  EventsPanel: () => <div>Event pane</div>,
}));
jest.mock("@/components/SorobanCliTerminal", () => ({
  SorobanCliTerminal: () => <div>Terminal pane</div>,
}));

test("root live regions have stable urgency and IDs", () => {
  render(<ScreenReaderAnnouncer />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
});
test("skip links move focus to the requested region", () => {
  render(
    <>
      <SkipNavigation />
      <main id="main-content" tabIndex={-1} />
      <section id="workspace-editor" tabIndex={-1} />
    </>,
  );
  HTMLElement.prototype.scrollIntoView = jest.fn();
  fireEvent.click(screen.getByRole("link", { name: "Skip to editor" }));
  expect(document.activeElement?.id).toBe("workspace-editor");
  expect(screen.queryByRole("link", { name: "Skip to console" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Skip to main content" }));
  expect(document.activeElement?.id).toBe("main-content");
});
test("modal hook handles Escape, contains Tab and restores trigger focus", () => {
  function Dialog() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useModalAccessibility(ref, open, () => setOpen(false));
    return (
      <>
        <button onClick={() => setOpen(true)}>Open dialog</button>
        {open && (
          <div ref={ref} role="dialog" aria-modal="true" aria-label="Test">
            <button>First</button>
            <button>Last</button>
          </div>
        )}
      </>
    );
  }
  render(<Dialog />);
  const trigger = screen.getByRole("button", { name: "Open dialog" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  screen.getByRole("button", { name: "Last" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
});
test("output tabs support arrows and selection semantics", () => {
  render(
    <ConsoleAndEventsDrawer
      logs={[]}
      isIngestionPaused={false}
      onIngestionPauseChange={jest.fn()}
    />,
  );
  const consoleTab = screen.getByRole("tab", { name: "Console Output" });
  consoleTab.focus();
  fireEvent.keyDown(consoleTab, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "CLI Terminal" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("tabpanel")).toHaveTextContent("Terminal pane");
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(screen.getByRole("tab", { name: "Event Streamer" })).toHaveFocus();
});

test("busy build controls retain keyboard focus and prevent duplicate requests", () => {
  const onCompile = jest.fn();
  const props = {
    onCompile,
    onDeploy: jest.fn(),
    isCompiling: false,
    isDeploying: false,
    hasCompiled: true,
  };
  const { rerender } = render(<DeployPanel {...props} />);
  const button = screen.getByRole("button", { name: "Compile", exact: true });
  button.focus();
  rerender(<DeployPanel {...props} isCompiling />);
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(button);
  expect(onCompile).not.toHaveBeenCalled();
  rerender(<DeployPanel {...props} />);
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(onCompile).toHaveBeenCalledTimes(1);
});

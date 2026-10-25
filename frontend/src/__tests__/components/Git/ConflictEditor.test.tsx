/**
 * Unit tests for the ConflictEditor component (issue #1727 / FE-27).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import ConflictEditor from "@/components/Git/ConflictEditor";

const CONFLICTED = [
  "fn main() {",
  "<<<<<<< HEAD",
  '    println!("current");',
  "=======",
  '    println!("incoming");',
  ">>>>>>> feature/hello",
  "}",
  "",
].join("\n");

const DIFF3_CONFLICTED = [
  "fn main() {",
  "<<<<<<< HEAD",
  '    println!("current");',
  "||||||| merged common ancestors",
  '    println!("base");',
  "=======",
  '    println!("incoming");',
  ">>>>>>> feature/hello",
  "}",
  "",
].join("\n");

describe("components/Git/ConflictEditor", () => {
  it("renders an empty state when there is no conflict", () => {
    render(<ConflictEditor path="src/lib.rs" content={"fn main() {}\n"} />);
    expect(screen.getByTestId("conflict-editor-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-editor")).not.toBeInTheDocument();
  });

  it("renders one card per conflicting region", () => {
    render(<ConflictEditor path="src/lib.rs" content={CONFLICTED} />);
    expect(screen.getByTestId("conflict-editor")).toBeInTheDocument();
    expect(screen.getAllByTestId("conflict-hunk")).toHaveLength(1);
  });

  it("shows the current and the incoming side", () => {
    render(<ConflictEditor path="src/lib.rs" content={CONFLICTED} />);
    expect(screen.getByTestId("conflict-1-current")).toHaveTextContent(
      'println!("current");',
    );
    expect(screen.getByTestId("conflict-1-incoming")).toHaveTextContent(
      'println!("incoming");',
    );
  });

  it("shows the base side for diff3 style conflicts", () => {
    render(<ConflictEditor path="src/lib.rs" content={DIFF3_CONFLICTED} />);
    expect(screen.getByTestId("conflict-1-base")).toHaveTextContent(
      'println!("base");',
    );
  });

  it("reports the chosen resolution", () => {
    const onResolutionChange = jest.fn();
    render(
      <ConflictEditor
        path="src/lib.rs"
        content={CONFLICTED}
        onResolutionChange={onResolutionChange}
      />,
    );

    fireEvent.click(screen.getByTestId("conflict-1-accept-incoming"));
    expect(onResolutionChange).toHaveBeenCalledWith("conflict-1", "incoming");

    fireEvent.click(screen.getByTestId("conflict-1-accept-current"));
    expect(onResolutionChange).toHaveBeenCalledWith("conflict-1", "current");
  });

  it("marks a resolved hunk with a badge", () => {
    render(
      <ConflictEditor
        path="src/lib.rs"
        content={CONFLICTED}
        resolutions={{ "conflict-1": "current" }}
      />,
    );
    expect(screen.getByTestId("conflict-resolved-badge")).toHaveTextContent(
      "Current accepted",
    );
  });

  it("shows the combined input only for the combined resolution", () => {
    const { rerender } = render(
      <ConflictEditor
        path="src/lib.rs"
        content={CONFLICTED}
        resolutions={{ "conflict-1": "current" }}
      />,
    );
    expect(screen.queryByTestId("conflict-1-combined-input")).not.toBeInTheDocument();

    rerender(
      <ConflictEditor
        path="src/lib.rs"
        content={CONFLICTED}
        resolutions={{ "conflict-1": "combined" }}
      />,
    );
    expect(screen.getByTestId("conflict-1-combined-input")).toBeInTheDocument();
  });

  it("reports manual edits of the combined text", () => {
    const onCombinedTextChange = jest.fn();
    render(
      <ConflictEditor
        path="src/lib.rs"
        content={CONFLICTED}
        resolutions={{ "conflict-1": "combined" }}
        combinedTexts={{ "conflict-1": "merged\n" }}
        onCombinedTextChange={onCombinedTextChange}
      />,
    );

    fireEvent.change(screen.getByTestId("conflict-1-combined-input"), {
      target: { value: "merged by hand\n" },
    });
    expect(onCombinedTextChange).toHaveBeenCalledWith(
      "conflict-1",
      "merged by hand\n",
    );
  });

  it("previews the resolved file without the conflict markers", () => {
    render(
      <ConflictEditor
        path="src/lib.rs"
        content={CONFLICTED}
        resolutions={{ "conflict-1": "incoming" }}
      />,
    );

    const preview = screen.getByTestId("conflict-editor-preview");
    expect(preview).not.toHaveTextContent("<<<<<<<");
    expect(preview).not.toHaveTextContent("=======");
    expect(preview).not.toHaveTextContent(">>>>>>>");
    expect(preview).toHaveTextContent('println!("incoming");');
  });

  it("previews the current side while unresolved and strips the markers", () => {
    render(<ConflictEditor path="src/lib.rs" content={CONFLICTED} />);
    const preview = screen.getByTestId("conflict-editor-preview");
    expect(preview).not.toHaveTextContent("<<<<<<<");
    expect(preview).toHaveTextContent('println!("current");');
    expect(preview).not.toHaveTextContent('println!("incoming");');
  });
});

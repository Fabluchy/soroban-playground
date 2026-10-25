import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ThreeWayDiffViewer, {
  fetchVerifiedContractSource,
} from "../../components/Diff/ThreeWayDiffViewer";

jest.mock("@monaco-editor/react", () => ({
  DiffEditor: ({
    original,
    modified,
    options,
  }: {
    original: string;
    modified: string;
    options: { renderSideBySide: boolean };
  }) => (
    <div
      data-testid="diff-editor"
      data-original={original}
      data-modified={modified}
      data-side-by-side={String(options.renderSideBySide)}
    />
  ),
}));

const mainCode = "fn a() {}\nfn b() {}\nfn c() {}\n";
const localCode = "fn a() {}\nfn b_local() {}\nfn c() {}\n";
const verifiedCode = "fn a() {}\nfn b() {}\nfn c_verified() {}\n";

describe("ThreeWayDiffViewer", () => {
  it("falls back to the verification record when the source route is unavailable", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            sourceCode: verifiedCode,
            network: "testnet",
            status: "verified",
          },
        }),
      });

    const source = await fetchVerifiedContractSource(
      "CABC123",
      "https://api.example/",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example/api/verify/contracts/CABC123/source",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example/api/verify/contracts/CABC123",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(source.sourceCode).toBe(verifiedCode);
    expect(source.files).toEqual([
      { path: "src/lib.rs", content: verifiedCode },
    ]);
    expect(source.verified).toBe(true);
  });

  it("renders local, main, and verified sources and toggles diff modes", () => {
    render(
      <ThreeWayDiffViewer
        contractId="CABC123"
        localCode={localCode}
        mainCode={mainCode}
        verifiedCode={verifiedCode}
      />,
    );

    expect(screen.getByText("Working buffer")).toBeInTheDocument();
    expect(screen.getByText("Main baseline")).toBeInTheDocument();
    expect(screen.getByText(/verified on-chain/i)).toBeInTheDocument();
    expect(screen.getByTestId("diff-editor")).toHaveAttribute(
      "data-side-by-side",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /unified/i }));

    expect(screen.getByTestId("diff-editor")).toHaveAttribute(
      "data-side-by-side",
      "false",
    );
  });

  it("fetches verified source from the verification registry", async () => {
    const fetchVerifiedSource = jest.fn().mockResolvedValue({
      sourceCode: verifiedCode,
      files: [{ path: "src/lib.rs", content: verifiedCode }],
      network: "testnet",
      verified: true,
    });

    render(
      <ThreeWayDiffViewer
        contractId="CVERIFIED"
        localCode={localCode}
        mainCode={mainCode}
        fetchVerifiedSource={fetchVerifiedSource}
      />,
    );

    await waitFor(() => {
      expect(fetchVerifiedSource).toHaveBeenCalledWith("CVERIFIED");
    });

    fireEvent.click(screen.getByRole("button", { name: /on-chain vs main/i }));

    expect(screen.getByTestId("diff-editor")).toHaveAttribute(
      "data-modified",
      verifiedCode,
    );
    expect(screen.getByText(/verified testnet/i)).toBeInTheDocument();
  });

  it("cherry-picks a verified chunk into the working buffer", async () => {
    const onLocalCodeChange = jest.fn();

    render(
      <ThreeWayDiffViewer
        contractId="CABC123"
        localCode={localCode}
        mainCode={mainCode}
        verifiedCode={verifiedCode}
        onLocalCodeChange={onLocalCodeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /on-chain vs main/i }));
    fireEvent.click(screen.getByRole("button", { name: /cherry-pick/i }));

    expect(onLocalCodeChange).toHaveBeenCalledWith(
      "fn a() {}\nfn b_local() {}\nfn c_verified() {}\n",
    );
  });

  it("reverts a local chunk to the main baseline", () => {
    const onLocalCodeChange = jest.fn();

    render(
      <ThreeWayDiffViewer
        contractId="CABC123"
        localCode={localCode}
        mainCode={mainCode}
        verifiedCode={verifiedCode}
        onLocalCodeChange={onLocalCodeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^revert$/i }));

    expect(onLocalCodeChange).toHaveBeenCalledWith(mainCode);
  });

  it("merges non-overlapping on-chain changes", () => {
    const onLocalCodeChange = jest.fn();

    render(
      <ThreeWayDiffViewer
        contractId="CABC123"
        localCode={localCode}
        mainCode={mainCode}
        verifiedCode={verifiedCode}
        onLocalCodeChange={onLocalCodeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /merge on-chain/i }));

    expect(onLocalCodeChange).toHaveBeenCalledWith(
      "fn a() {}\nfn b_local() {}\nfn c_verified() {}\n",
    );
  });

  it("navigates diff chunks with F7 and Shift+F7", () => {
    const local = "fn a() {}\nfn b_local() {}\nfn c() {}\nfn d_local() {}\n";
    const main = "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}\n";

    render(
      <ThreeWayDiffViewer
        contractId="CABC123"
        localCode={local}
        mainCode={main}
        verifiedCode={main}
      />,
    );

    expect(screen.getByText("Chunk 1 of 2")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "F7" });
    expect(screen.getByText("Chunk 2 of 2")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "F7", shiftKey: true });
    expect(screen.getByText("Chunk 1 of 2")).toBeInTheDocument();
  });

  it("shows a registry error and allows retrying", async () => {
    const fetchVerifiedSource = jest
      .fn()
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce({
        sourceCode: verifiedCode,
        files: [{ path: "src/lib.rs", content: verifiedCode }],
        network: "testnet",
      });

    render(
      <ThreeWayDiffViewer
        contractId="CERROR"
        localCode={localCode}
        mainCode={mainCode}
        fetchVerifiedSource={fetchVerifiedSource}
      />,
    );

    expect(await screen.findByText("registry unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(fetchVerifiedSource).toHaveBeenCalledTimes(2);
    });
  });
});

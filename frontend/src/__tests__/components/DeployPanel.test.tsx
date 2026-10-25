import { render, screen, fireEvent } from "@testing-library/react";
import DeployPanel from "../../components/DeployPanel";

describe("DeployPanel", () => {
  const defaultProps = {
    onCompile: jest.fn(),
    onDeploy: jest.fn(),
    isCompiling: false,
    isDeploying: false,
    hasCompiled: false,
  };

  it("renders the heading", () => {
    render(<DeployPanel {...defaultProps} />);
    expect(screen.getByText("Build & Deploy")).toBeInTheDocument();
  });

  it("renders Compile and Deploy buttons", () => {
    render(<DeployPanel {...defaultProps} />);
    expect(
      screen.getByRole("button", { name: /compile/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /deploy to testnet/i }),
    ).toBeInTheDocument();
  });

  it("enables compile and disables deploy on initial state", () => {
    render(<DeployPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: /compile/i })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /deploy to testnet/i }),
    ).toBeDisabled();
  });

  it('shows spinner and "Compiling..." when compiling', () => {
    render(<DeployPanel {...defaultProps} isCompiling />);
    expect(screen.getByText("Compiling...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /compiling/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it('shows spinner and "Deploying..." when deploying', () => {
    render(<DeployPanel {...defaultProps} hasCompiled isDeploying />);
    expect(screen.getByText("Deploying...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deploying/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("enables deploy after successful compile", () => {
    render(<DeployPanel {...defaultProps} hasCompiled />);
    expect(
      screen.getByRole("button", { name: /deploy to testnet/i }),
    ).toBeEnabled();
  });

  it("calls onCompile when compile is clicked", () => {
    const onCompile = jest.fn();
    render(<DeployPanel {...defaultProps} onCompile={onCompile} />);
    fireEvent.click(screen.getByRole("button", { name: /compile/i }));
    expect(onCompile).toHaveBeenCalledTimes(1);
  });

  it("calls onDeploy when deploy is clicked", () => {
    const onDeploy = jest.fn();
    render(<DeployPanel {...defaultProps} hasCompiled onDeploy={onDeploy} />);
    fireEvent.click(screen.getByRole("button", { name: /deploy to testnet/i }));
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });

  it("displays contract ID when provided", () => {
    render(
      <DeployPanel
        {...defaultProps}
        hasCompiled
        contractId="CCXJBN3A4L7BQ5B..."
      />,
    );
    expect(screen.getByText(/active contract id/i)).toBeInTheDocument();
    expect(screen.getByText("CCXJBN3A4L7BQ5B...")).toBeInTheDocument();
  });

  it("does not show contract ID section when not provided", () => {
    render(<DeployPanel {...defaultProps} />);
    expect(screen.queryByText(/active contract id/i)).not.toBeInTheDocument();
  });

  it("shows compile success message", () => {
    render(
      <DeployPanel
        {...defaultProps}
        hasCompiled
        compileSummary="Compiled successfully. WASM size: 12.5 KB."
      />,
    );
    expect(
      screen.getByText("Compiled successfully. WASM size: 12.5 KB."),
    ).toBeInTheDocument();
  });

  it("shows compile error message", () => {
    render(
      <DeployPanel
        {...defaultProps}
        compileError="Line 42: expected identifier, found `fnc`"
      />,
    );
    expect(
      screen.getByText("Line 42: expected identifier, found `fnc`"),
    ).toBeInTheDocument();
  });

  it("hides success message when error is present", () => {
    render(
      <DeployPanel
        {...defaultProps}
        hasCompiled
        compileSummary="Compiled successfully"
        compileError="Compilation failed"
      />,
    );
    expect(screen.queryByText("Compiled successfully")).not.toBeInTheDocument();
    expect(screen.getByText("Compilation failed")).toBeInTheDocument();
  });

  it("disables both buttons while compiling", () => {
    render(<DeployPanel {...defaultProps} isCompiling />);
    expect(screen.getByRole("button", { name: /compiling/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /deploy to testnet/i }),
    ).toBeDisabled();
  });

  it("disables both buttons while deploying", () => {
    render(<DeployPanel {...defaultProps} hasCompiled isDeploying />);
    expect(screen.getByRole("button", { name: /compile/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /deploying/i })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("does not render contract ID on compile error even if contractId provided", () => {
    render(
      <DeployPanel
        {...defaultProps}
        contractId="CCXJBN3A4L7BQ5B..."
        compileError="Compilation failed"
      />,
    );
    expect(screen.queryByText(/active contract id/i)).not.toBeInTheDocument();
  });
});

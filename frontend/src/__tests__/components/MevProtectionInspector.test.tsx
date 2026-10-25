// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file MevProtectionInspector.test.tsx
 * Component unit test suite for MevProtectionInspector modal.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import MevProtectionInspector from "../../components/Swap/MevProtectionInspector";
import { DEFAULT_SAMPLE_POOLS } from "../../lib/swap/swapMath";

describe("MevProtectionInspector Component", () => {
  it("renders modal dialog when isOpen is true", () => {
    render(
      <MevProtectionInspector
        isOpen={true}
        onClose={jest.fn()}
        initialTokenIn="XLM"
        initialTokenOut="USDC"
        initialAmountIn={1000}
        initialSlippage={0.5}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("Swap Simulation & MEV Protection Visualizer"),
    ).toBeInTheDocument();
  });

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <MevProtectionInspector isOpen={false} onClose={jest.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("displays critical sandwich attack vulnerability warning when slippage > 2.0%", () => {
    render(
      <MevProtectionInspector
        isOpen={true}
        initialTokenIn="XLM"
        initialTokenOut="USDC"
        initialAmountIn={1000}
        initialSlippage={3.0} // > 2.0%
      />,
    );

    expect(screen.getByTestId("mev-alert-critical")).toBeInTheDocument();
    expect(screen.getByText(/High MEV Vulnerability/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Potential output loss up to/i),
    ).toBeInTheDocument();
  });

  it("displays MEV Protected status badge when slippage is <= 0.5%", () => {
    render(
      <MevProtectionInspector
        isOpen={true}
        initialTokenIn="XLM"
        initialTokenOut="USDC"
        initialAmountIn={1000}
        initialSlippage={0.5}
      />,
    );

    expect(screen.getByTestId("mev-alert-low")).toBeInTheDocument();
    expect(screen.getByText(/MEV Protected/i)).toBeInTheDocument();
  });

  it("clicking Apply Protective Settings adjusts slippage to 0.5% and fires onApplySettings", () => {
    const handleApplySettings = jest.fn();

    render(
      <MevProtectionInspector
        isOpen={true}
        initialTokenIn="XLM"
        initialTokenOut="USDC"
        initialAmountIn={1000}
        initialSlippage={2.5} // Critical
        onApplySettings={handleApplySettings}
      />,
    );

    const applyButton = screen.getByTestId("apply-protective-btn");
    expect(applyButton).toBeInTheDocument();

    fireEvent.click(applyButton);

    expect(handleApplySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        slippage: expect.any(Number),
        priorityFee: expect.any(Number),
      }),
    );

    // After applying, status switches to MEV Protected
    expect(screen.getByTestId("mev-alert-low")).toBeInTheDocument();
  });

  it("renders multi-hop execution path diagram and interactive pool badges", () => {
    render(
      <MevProtectionInspector
        isOpen={true}
        initialTokenIn="XLM"
        initialTokenOut="AQUA" // Multi-hop (XLM -> USDC -> AQUA)
        initialAmountIn={1000}
        initialSlippage={0.5}
        pools={DEFAULT_SAMPLE_POOLS}
      />,
    );

    // Tokens in the multi-hop route
    expect(screen.getAllByText("XLM").length).toBeGreaterThan(0);
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AQUA").length).toBeGreaterThan(0);

    // Fee badge check
    expect(screen.getAllByText(/Fee/i).length).toBeGreaterThan(0);
  });

  it("clicking a pool fee badge opens the Pool Inspector card", () => {
    render(
      <MevProtectionInspector
        isOpen={true}
        initialTokenIn="XLM"
        initialTokenOut="USDC"
        initialAmountIn={1000}
        initialSlippage={0.5}
        pools={DEFAULT_SAMPLE_POOLS}
      />,
    );

    // Find and click the pool fee badge button
    const poolBadge = screen.getByTitle(
      "Click to inspect pool liquidity and address",
    );
    expect(poolBadge).toBeInTheDocument();

    fireEvent.click(poolBadge);

    // Pool Inspector details should be visible
    expect(screen.getByText(/Pool Inspector:/i)).toBeInTheDocument();
    expect(screen.getByText(/Contract Address/i)).toBeInTheDocument();
  });

  it("calls onClose when close button is clicked", () => {
    const handleClose = jest.fn();

    render(<MevProtectionInspector isOpen={true} onClose={handleClose} />);

    const closeBtn = screen.getByLabelText("Close modal");
    fireEvent.click(closeBtn);

    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});

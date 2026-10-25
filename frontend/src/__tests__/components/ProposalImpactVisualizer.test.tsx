import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ProposalImpactVisualizer from "@/components/Gov/ProposalImpactVisualizer";
import { INITIAL_GOVERNANCE_PROPOSALS } from "@/lib/gov/mockProposals";

describe("ProposalImpactVisualizer Component", () => {
  it("renders visualizer title, stats banner, and proposal list", () => {
    render(<ProposalImpactVisualizer />);

    expect(
      screen.getByTestId("proposal-impact-visualizer"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Governance Proposal Impact Visualizer"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /PIP-14/ })).toBeInTheDocument();
  });

  it("filters proposals by status, including executed proposals", () => {
    render(<ProposalImpactVisualizer />);

    const passedTab = screen.getByRole("button", { name: "Passed" });
    fireEvent.click(passedTab);

    // PIP-16 is Passed
    expect(screen.getByRole("button", { name: /PIP-16/ })).toBeInTheDocument();
    // PIP-14 is Active, should not be in the list
    expect(
      screen.queryByText("Reduce AMM Swap Protocol Fee from 30 bps to 20 bps"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Executed" }));
    expect(screen.getByRole("button", { name: /PIP-12/ })).toBeInTheDocument();
  });

  it("selects proposal and renders quorum and approval meters", () => {
    render(<ProposalImpactVisualizer />);

    // By default, PIP-14 is selected
    expect(screen.getByText("Quorum Threshold")).toBeInTheDocument();
    expect(screen.getByText("Approval Ratio")).toBeInTheDocument();
    expect(
      screen.getByText(/Forecasted Execution Impact & Ledger State Diffs/i),
    ).toBeInTheDocument();
  });

  it("renders quadratic voting curve simulator for QV-enabled proposals", () => {
    render(<ProposalImpactVisualizer />);

    expect(
      screen.getByText(/Quadratic Voting Cost Curve & Simulator/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Quadratic credit allocation slider/i),
    ).toBeInTheDocument();

    const slider = screen.getByLabelText(/Quadratic credit allocation slider/i);
    fireEvent.change(slider, { target: { value: "144" } });

    // sqrt(144) = 12 votes
    expect(screen.getByText("12 Votes")).toBeInTheDocument();
  });

  it("renders prospective state diff table with critical keys", () => {
    render(<ProposalImpactVisualizer />);

    expect(screen.getByText("fee_rate_bps")).toBeInTheDocument();
    expect(screen.getByText("fee_recipient")).toBeInTheDocument();
    expect(screen.getAllByText("Critical").length).toBeGreaterThan(0);
  });

  it("allows casting a single vote with confirmation", async () => {
    const onVoteSubmitMock = jest.fn();
    render(<ProposalImpactVisualizer onVoteSubmit={onVoteSubmitMock} />);

    // Click 'Vote Against'
    const againstBtn = screen.getByRole("button", { name: /Vote Against/i });
    fireEvent.click(againstBtn);

    // Submit vote
    const submitBtn = screen.getByRole("button", { name: /Authorize Vote/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onVoteSubmitMock).toHaveBeenCalledWith("PIP-14", "Against", 100);
      expect(screen.getByText(/Vote callback completed/i)).toBeInTheDocument();
    });
  });

  it("opens batch voting modal and submits multi-proposal votes", async () => {
    const onBatchVoteMock = jest.fn();
    render(<ProposalImpactVisualizer onBatchVoteSubmit={onBatchVoteMock} />);

    const batchBtn = screen.getByRole("button", { name: /Batch Voting/i });
    fireEvent.click(batchBtn);

    expect(screen.getByText("Batch Proposal Voting")).toBeInTheDocument();

    const submitBatchBtn = screen.getByRole("button", {
      name: /Submit Batch Votes/i,
    });
    const credits = screen.getByLabelText("Credits for PIP-14");
    fireEvent.change(credits, { target: { value: "75" } });
    fireEvent.click(submitBatchBtn);

    await waitFor(() => {
      expect(onBatchVoteMock).toHaveBeenCalled();
      expect(onBatchVoteMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ proposalId: "PIP-14", credits: 75 }),
        ]),
      );
      expect(screen.getByText(/Batch callback completed/i)).toBeInTheDocument();
    });
  });

  it("clearly labels a vote without a host callback as a local demo", async () => {
    render(<ProposalImpactVisualizer />);
    fireEvent.click(screen.getByRole("button", { name: /Authorize Vote/i }));
    await waitFor(() => {
      expect(
        screen.getByText(
          /Demo vote recorded locally. No on-chain transaction was submitted./i,
        ),
      ).toBeInTheDocument();
    });
  });
});

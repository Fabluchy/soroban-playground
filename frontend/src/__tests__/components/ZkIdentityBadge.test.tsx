// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file ZkIdentityBadge.test.tsx
 * Component tests for fail-closed credential status, proof details, and export.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ZkIdentityBadge from "../../components/Identity/ZkIdentityBadge";
import { SAMPLE_CREDENTIALS } from "../../lib/zk/sampleCredentials";
import { bn254 } from "@noble/curves/bn254";

const hex32 = (value: bigint) => value.toString(16).padStart(64, "0");
function validCredential() {
  const g1 = bn254.G1.ProjectivePoint.BASE;
  const g2 = bn254.G2.ProjectivePoint.BASE;
  const affine1 = g1.toAffine();
  const affine2 = g2.toAffine();
  const fp2 = (value: typeof affine2.x) => bn254.fields.Fp2.reim(value);
  const x = fp2(affine2.x);
  const y = fp2(affine2.y);
  const g1Hex = hex32(affine1.x) + hex32(affine1.y);
  const g2Hex = hex32(x.im) + hex32(x.re) + hex32(y.im) + hex32(y.re);
  const proofA = g1.multiply(3n).toAffine();
  return {
    ...SAMPLE_CREDENTIALS[0],
    proof: { a: hex32(proofA.x) + hex32(proofA.y), b: g2Hex, c: g1Hex },
    verificationKey: {
      alphaG1: g1Hex,
      betaG2: g2Hex,
      gammaG2: g2Hex,
      deltaG2: g2Hex,
      ic: [g1Hex],
    },
    publicInputs: { ...SAMPLE_CREDENTIALS[0].publicInputs, signals: [] },
  };
}

describe("ZkIdentityBadge Component", () => {
  it("keeps the synthetic sample credential unverified", () => {
    const verifiedCred = SAMPLE_CREDENTIALS[0]; // Developer score > 80
    render(<ZkIdentityBadge credential={verifiedCred} mode="badge" />);

    const badgeBtn = screen.getByTestId(`zk-badge-${verifiedCred.id}`);
    expect(badgeBtn).toBeInTheDocument();
    expect(screen.getByText("Senior Soroban Developer")).toBeInTheDocument();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
  });

  it("shows the glowing verified badge after a successful local proof check", async () => {
    const credential = validCredential();
    render(
      <ZkIdentityBadge
        credential={credential}
        mode="badge"
        showModalInitially
      />,
    );
    fireEvent.click(screen.getByTestId("verify-proof-btn"));
    await waitFor(() =>
      expect(screen.getByText("zkID Verified")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Verified with GROTH16_BN254/)).toBeInTheDocument();
  });

  it("renders distinct unverified styling and status tag for unverified credentials", () => {
    const unverifiedCred = SAMPLE_CREDENTIALS[3]; // Accredited Investor (unverified)
    render(<ZkIdentityBadge credential={unverifiedCred} mode="badge" />);

    const badgeBtn = screen.getByTestId(`zk-badge-${unverifiedCred.id}`);
    expect(badgeBtn).toBeInTheDocument();
    expect(screen.getByText("Accredited Investor Status")).toBeInTheDocument();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
  });

  it("renders in card mode and displays privacy seal", () => {
    const verifiedCred = SAMPLE_CREDENTIALS[0];
    render(<ZkIdentityBadge credential={verifiedCred} mode="card" />);

    expect(
      screen.getByTestId(`zk-card-${verifiedCred.id}`),
    ).toBeInTheDocument();
    expect(screen.getByText("Claim is unverified")).toBeInTheDocument();
    expect(screen.getByText("Inspect Proof")).toBeInTheDocument();
  });

  it("opens detailed cryptographic proof modal upon clicking badge", () => {
    const verifiedCred = SAMPLE_CREDENTIALS[0];
    render(<ZkIdentityBadge credential={verifiedCred} mode="badge" />);

    const badgeBtn = screen.getByTestId(`zk-badge-${verifiedCred.id}`);
    fireEvent.click(badgeBtn);

    // Modal dialog is displayed
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("Zero-Knowledge Proof Inspector"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Proof privacy/i)).toBeInTheDocument();
  });

  it("displays canonical public inputs and verification timestamp in modal", () => {
    const verifiedCred = SAMPLE_CREDENTIALS[0];
    render(
      <ZkIdentityBadge
        credential={verifiedCred}
        mode="badge"
        showModalInitially={true}
      />,
    );

    // Verify Public inputs are present
    expect(screen.getByText("Canonical Public Inputs")).toBeInTheDocument();
    expect(
      screen.getByText(verifiedCred.publicInputs.merkleRoot),
    ).toBeInTheDocument();
    expect(
      screen.getByText(verifiedCred.publicInputs.schemaId),
    ).toBeInTheDocument();
    expect(
      screen.getByText(verifiedCred.publicInputs.nullifierHash),
    ).toBeInTheDocument();
    expect(screen.getByText(/Issuance Timestamp/i)).toBeInTheDocument();
  });

  it("offers local verification and reports when circuit signals are absent", async () => {
    const verifiedCred = SAMPLE_CREDENTIALS[0];
    const handleVerify = jest.fn();

    render(
      <ZkIdentityBadge
        credential={verifiedCred}
        mode="badge"
        showModalInitially={true}
        onVerify={handleVerify}
      />,
    );

    const verifyBtn = screen.getByTestId("verify-proof-btn");
    fireEvent.click(verifyBtn);

    await waitFor(() => {
      expect(handleVerify).toHaveBeenCalled();
    });

    expect(
      screen.getByText(/Ordered circuit public signals/i, { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("clicking Export Groth16 JSON exports the portable verifier bundle", async () => {
    const verifiedCred = validCredential();
    const handleExport = jest.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
    });

    render(
      <ZkIdentityBadge
        credential={verifiedCred}
        mode="badge"
        showModalInitially={true}
        onExport={handleExport}
      />,
    );

    fireEvent.click(screen.getByTestId("verify-proof-btn"));
    const exportBtn = screen.getByTestId("export-token-btn");
    await waitFor(() => expect(exportBtn).toBeEnabled());
    fireEvent.click(exportBtn);

    await waitFor(() =>
      expect(handleExport).toHaveBeenCalledWith(
        expect.objectContaining({
          version: "1.0.0",
          type: "ZkVerifiableCredential",
          credentialId: verifiedCred.id,
          groth16: expect.objectContaining({
            protocol: "groth16",
            curve: "bn128",
          }),
        }),
      ),
    );

    await waitFor(() =>
      expect(screen.getByText("Copied JSON!")).toBeInTheDocument(),
    );
  });

  it("closes modal on close button click", () => {
    const verifiedCred = SAMPLE_CREDENTIALS[0];
    render(
      <ZkIdentityBadge
        credential={verifiedCred}
        mode="badge"
        showModalInitially={true}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const closeBtn = screen.getByLabelText("Close modal");
    fireEvent.click(closeBtn);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

import {
  Contract,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type {
  ZkCredential,
  ZkVerificationKey,
  ZkVerificationResult,
} from "./types";

export interface SorobanVerifierConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  /** Existing account on the selected network; simulation is read-only. */
  sourceAccount: string;
  /** Trusted key for the exact circuit used by encodePublicInputs. */
  verificationKey: ZkVerificationKey;
  /** Ordered canonical BN254 Fr scalars as 32-byte big-endian hex. */
  encodePublicInputs: (credential: ZkCredential) => string[];
}

function bytes(hex: string, length: number): xdr.ScVal {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const pattern = new RegExp("^[0-9a-fA-F]{" + length * 2 + "}$");
  if (!pattern.test(clean)) {
    throw new Error("Expected " + length + " bytes of hexadecimal data");
  }
  return xdr.ScVal.scvBytes(Buffer.from(clean, "hex"));
}

function struct(fields: Array<[string, xdr.ScVal]>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    [...fields].sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val,
        }),
    ),
  );
}

function encodeVerificationKey(key: ZkVerificationKey): xdr.ScVal {
  if (!Array.isArray(key.ic) || key.ic.length === 0) {
    throw new Error("Trusted verification key has no IC points");
  }
  return struct([
    ["alpha_g1", bytes(key.alphaG1, 64)],
    ["beta_g2", bytes(key.betaG2, 128)],
    ["gamma_g2", bytes(key.gammaG2, 128)],
    ["delta_g2", bytes(key.deltaG2, 128)],
    ["ic", xdr.ScVal.scvVec(key.ic.map((point) => bytes(point, 64)))],
  ]);
}

function encodeProof(credential: ZkCredential): xdr.ScVal {
  return struct([
    ["a", bytes(credential.proof.a, 64)],
    ["b", bytes(credential.proof.b, 128)],
    ["c", bytes(credential.proof.c, 64)],
  ]);
}

function errorResult(error: unknown, startedAt: number): ZkVerificationResult {
  return {
    isValid: false,
    verificationLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
    verifiedAt: Date.now(),
    verificationMethod: "SOROBAN_RPC_SIMULATION",
    errorReason: error instanceof Error ? error.message : "Soroban verification failed",
  };
}

/** Build a verifier callback suitable for ZkIdentityBadge.verifyWithSoroban. */
export function createSorobanVerifier(config: SorobanVerifierConfig) {
  return async (credential: ZkCredential): Promise<ZkVerificationResult> => {
    const startedAt = performance.now();
    try {
      const inputHex = config.encodePublicInputs(credential);
      if (!Array.isArray(inputHex) || inputHex.length > 64) {
        throw new Error("Circuit encoder returned an invalid public-input list");
      }
      const inputs = xdr.ScVal.scvVec(inputHex.map((scalar) => bytes(scalar, 32)));
      const server = new rpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
      });
      const account = await server.getAccount(config.sourceAccount);
      const transaction = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          new Contract(config.contractId).call(
            "verify",
            encodeVerificationKey(config.verificationKey),
            encodeProof(credential),
            inputs,
          ),
        )
        .setTimeout(30)
        .build();
      const simulation = await server.simulateTransaction(transaction);
      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(simulation.error);
      }
      if (!simulation.result?.retval) {
        throw new Error("Verifier simulation returned no result");
      }
      const isValid = scValToNative(simulation.result.retval);
      if (typeof isValid !== "boolean") {
        throw new Error("Verifier returned a non-boolean result");
      }
      return {
        isValid,
        verificationLatencyMs: Number((performance.now() - startedAt).toFixed(2)),
        verifiedAt: Date.now(),
        verificationMethod: "SOROBAN_RPC_SIMULATION",
        ...(isValid ? {} : { errorReason: "Soroban verifier rejected the proof" }),
      };
    } catch (error) {
      return errorResult(error, startedAt);
    }
  };
}

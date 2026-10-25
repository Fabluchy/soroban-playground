/**
 * Host-side postMessage dispatcher and offline demo simulator for the sandbox preview.
 * It never calls /api/invoke because that endpoint can execute state-changing transactions.
 */

import type {
  ContractSimulateRequest,
  ContractSimulateResponse,
  DappConsoleLog,
  MockWalletConfig,
} from "./types";
import { createMockSignedTxXdr } from "./mockWallet.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isConsoleLog(value: unknown): value is DappConsoleLog {
  if (!isRecord(value)) return false;
  const levels = ["log", "info", "warn", "error", "debug"];
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    levels.includes(String(value.level)) &&
    typeof value.message === "string" &&
    value.message.length <= 20_000 &&
    Number.isFinite(value.timestamp) &&
    (value.stack === undefined ||
      (typeof value.stack === "string" && value.stack.length <= 20_000)) &&
    (value.args === undefined ||
      (Array.isArray(value.args) &&
        value.args.length <= 100 &&
        value.args.every(
          (arg) => typeof arg === "string" && arg.length <= 20_000,
        )))
  );
}

export function isContractSimulateRequest(
  value: unknown,
): value is ContractSimulateRequest {
  if (
    !isRecord(value) ||
    typeof value.contractId !== "string" ||
    value.contractId.length < 1 ||
    value.contractId.length > 128 ||
    typeof value.functionName !== "string" ||
    value.functionName.length < 1 ||
    value.functionName.length > 128
  )
    return false;
  if (
    value.network !== undefined &&
    !["testnet", "futurenet", "local"].includes(
      String(value.network).toLowerCase(),
    )
  )
    return false;
  if (
    value.args !== undefined &&
    !Array.isArray(value.args) &&
    !isRecord(value.args)
  )
    return false;
  try {
    return JSON.stringify(value.args ?? {}).length <= 64_000;
  } catch {
    return false;
  }
}

function isMessageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Deterministic local demo responses for a small set of known function names.
 */
export function simulateContractInMemory(
  req: ContractSimulateRequest,
): ContractSimulateResponse {
  const func = (req.functionName || "").toLowerCase().trim();
  const args = req.args || {};
  const contractId = req.contractId || "UNKNOWN_CONTRACT";

  let output: unknown;
  let gasFeeStroops = 1450;

  switch (func) {
    case "hello":
      if (typeof args === "object" && !Array.isArray(args) && args !== null) {
        output = (args as Record<string, unknown>).name || "world";
      } else if (Array.isArray(args) && args.length > 0) {
        output = args[0];
      } else {
        output = "Soroban";
      }
      gasFeeStroops = 1200;
      break;

    case "version":
      output = "v1.0.0";
      gasFeeStroops = 800;
      break;

    case "balance":
    case "get_balance":
      output = "10000000000"; // 1,000.0000000 tokens
      gasFeeStroops = 2100;
      break;

    case "increment":
    case "counter":
      output = 42;
      gasFeeStroops = 3500;
      break;

    default:
      gasFeeStroops = 2500;
      break;
  }

  const supportedFunctions = [
    "hello",
    "version",
    "balance",
    "get_balance",
    "increment",
    "counter",
  ];
  if (!supportedFunctions.includes(func)) {
    return {
      success: false,
      executionMode: "mock",
      contractId,
      functionName: req.functionName,
      error: `No offline simulation is implemented for ${req.functionName}`,
      message:
        "This offline fallback does not execute arbitrary Soroban contracts",
      timestamp: Date.now(),
    };
  }

  return {
    success: true,
    executionMode: "mock",
    contractId,
    functionName: req.functionName,
    output,
    gasFeeStroops,
    message: `Deterministic simulation executed for ${req.functionName}`,
    timestamp: Date.now(),
  };
}

/**
 * Run a local demo simulation. The second argument is ignored for compatibility;
 * sandbox content must not reach the state-changing /api/invoke endpoint.
 */
export async function executeContractSimulation(
  req: unknown,
  _apiBaseUrl?: string,
): Promise<ContractSimulateResponse> {
  if (!isContractSimulateRequest(req)) {
    const invalidRequest = isRecord(req) ? req : {};
    return {
      success: false,
      executionMode: "mock",
      contractId:
        typeof invalidRequest.contractId === "string"
          ? invalidRequest.contractId
          : "UNKNOWN_CONTRACT",
      functionName:
        typeof invalidRequest.functionName === "string"
          ? invalidRequest.functionName
          : "UNKNOWN_FUNCTION",
      error: "Invalid contract simulation request",
      timestamp: Date.now(),
    };
  }
  return simulateContractInMemory(req);
}

export interface MessageHandlerOptions {
  walletConfig: MockWalletConfig;
  onConsoleLog: (log: DappConsoleLog) => void;
  onWalletSignRequest?: (xdr: string) => void;
  apiBaseUrl?: string;
}

/**
 * Handles incoming postMessage events from the sandboxed iframe.
 */
export function handleIframeBridgeMessage(
  event: MessageEvent,
  iframeContentWindow: Window | null,
  options: MessageHandlerOptions,
): void {
  const data = event.data;

  // The bridge label is not authentication; require the exact registered frame.
  if (
    !iframeContentWindow ||
    event.source !== iframeContentWindow ||
    !isRecord(data) ||
    data.source !== "soroban-playground-dapp-bridge" ||
    !isMessageId(data.id)
  ) {
    return;
  }

  switch (data.type) {
    case "DAPP_CONSOLE_LOG":
      if (isConsoleLog(data.payload)) {
        options.onConsoleLog(data.payload);
      }
      break;

    case "SOROBAN_SIMULATE_REQUEST":
      if (isContractSimulateRequest(data.payload)) {
        const request = data.payload;
        executeContractSimulation(request, options.apiBaseUrl)
          .then((result) => {
            iframeContentWindow.postMessage(
              {
                source: "soroban-playground-host",
                type: "SOROBAN_SIMULATE_RESPONSE",
                id: data.id,
                payload: result,
              },
              "*",
            );
          })
          .catch((err) => {
            iframeContentWindow.postMessage(
              {
                source: "soroban-playground-host",
                type: "SOROBAN_SIMULATE_RESPONSE",
                id: data.id,
                payload: {
                  success: false,
                  executionMode: "mock",
                  contractId: request.contractId,
                  functionName: request.functionName,
                  error: err?.message || "Simulation error",
                  timestamp: Date.now(),
                },
              },
              "*",
            );
          });
      }
      break;

    case "WALLET_SIGN_REQUEST":
      if (
        isRecord(data.payload) &&
        typeof data.payload.xdr === "string" &&
        data.payload.xdr.length > 0 &&
        data.payload.xdr.length <= 64_000
      ) {
        const xdr = data.payload.xdr;
        if (
          options.walletConfig.isConnected &&
          typeof options.onWalletSignRequest === "function"
        ) {
          options.onWalletSignRequest(xdr);
        }

        try {
          if (!options.walletConfig.isConnected)
            throw new Error("Mock wallet is disconnected");
          const signedTxXdr = createMockSignedTxXdr(
            xdr,
            options.walletConfig.address,
          );
          iframeContentWindow.postMessage(
            {
              source: "soroban-playground-host",
              type: "WALLET_SIGN_RESPONSE",
              id: data.id,
              payload: { signedTxXdr, isMock: true },
            },
            "*",
          );
        } catch (e: unknown) {
          const errorMsg = e instanceof Error ? e.message : "Signing failure";
          iframeContentWindow.postMessage(
            {
              source: "soroban-playground-host",
              type: "WALLET_SIGN_RESPONSE",
              id: data.id,
              payload: { error: errorMsg },
            },
            "*",
          );
        }
      }
      break;

    case "SANDBOX_READY":
      // DApp has initialized the bridge
      break;

    default:
      break;
  }
}

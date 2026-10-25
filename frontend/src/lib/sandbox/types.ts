/**
 * Types and interfaces for the Sandboxed DApp IFrame Preview container,
 * virtual wallet bridge, console interception, and contract simulation routing.
 */

export type ViewportPreset = 'iphone' | 'ipad' | 'desktop' | 'responsive';
export type ViewportOrientation = 'portrait' | 'landscape';
export type ViewportScale = 0.5 | 0.75 | 1 | 'fit';

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface ViewportPresetConfig {
  id: ViewportPreset;
  name: string;
  dimensions: ViewportDimensions;
  canRotate: boolean;
  hasDeviceFrame: boolean;
}

export type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface DappConsoleLog {
  id: string;
  level: ConsoleLogLevel;
  message: string;
  args?: string[];
  timestamp: number;
  stack?: string;
}

export interface MockWalletAccount {
  address: string;
  name: string;
  balanceXlm?: string;
}

export interface MockWalletConfig {
  address: string;
  network: string;
  networkPassphrase: string;
  networkUrl: string;
  isConnected: boolean;
  isAllowed: boolean;
  allAccounts: MockWalletAccount[];
}

export interface ContractSimulateRequest {
  contractId: string;
  functionName: string;
  args?: Record<string, unknown> | unknown[];
  network?: string;
}

export interface ContractSimulateResponse {
  success: boolean;
  executionMode: 'mock';
  contractId: string;
  functionName: string;
  output?: unknown;
  error?: string;
  message?: string;
  gasFeeStroops?: number;
  timestamp: number;
}

export type BridgeMessageType =
  | 'DAPP_CONSOLE_LOG'
  | 'SOROBAN_SIMULATE_REQUEST'
  | 'SOROBAN_SIMULATE_RESPONSE'
  | 'WALLET_GET_STATE_REQUEST'
  | 'WALLET_GET_STATE_RESPONSE'
  | 'WALLET_SIGN_REQUEST'
  | 'WALLET_SIGN_RESPONSE'
  | 'SANDBOX_READY'
  | 'PARENT_CONFIG_UPDATE';

export interface BridgeMessage<T = unknown> {
  source: 'soroban-playground-dapp-bridge' | 'soroban-playground-host';
  type: BridgeMessageType;
  id: string;
  payload: T;
}

export interface DappTemplate {
  name: string;
  description: string;
  html: string;
  js: string;
  css: string;
}

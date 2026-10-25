export interface MockTransactionResponse {
  status: 'SUCCESS' | 'ERROR';
  results?: any[];
  error?: string;
  feeCharged: string;
}

export interface MockRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: any;
}

export interface MockRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export class MockRpcEngine {
  private ledgerSequence: number = 100000;
  private ledgerEntries: Map<string, string> = new Map();
  private scenarioOverrides: Map<string, MockTransactionResponse> = new Map();

  constructor() {
    // Seed default ledger state & test accounts
    this.ledgerEntries.set(
      'GABC...DEFAULT',
      JSON.stringify({ balance: '10000000000', seq: 1 })
    );
  }

  /**
   * Configure programmatic scenario behavior for specific methods/transactions
   */
  public setScenarioOverride(
    txHash: string,
    response: MockTransactionResponse
  ): void {
    this.scenarioOverrides.set(txHash, response);
  }

  public clearScenarios(): void {
    this.scenarioOverrides.clear();
  }

  /**
   * Export in-memory state snapshot for test fixture resets
   */
  public exportSnapshot(): {
    ledgerSequence: number;
    entries: [string, string][];
  } {
    return {
      ledgerSequence: this.ledgerSequence,
      entries: Array.from(this.ledgerEntries.entries()),
    };
  }

  /**
   * Restore state from a previously exported snapshot
   */
  public restoreSnapshot(snapshot: {
    ledgerSequence: number;
    entries: [string, string][];
  }): void {
    this.ledgerSequence = snapshot.ledgerSequence;
    this.ledgerEntries = new Map(snapshot.entries);
  }

  /**
   * Handle incoming JSON-RPC 2.0 request
   */
  public handleRequest(req: MockRpcRequest): MockRpcResponse {
    const { jsonrpc = '2.0', id, method, params } = req;

    try {
      let result: any;

      switch (method) {
        case 'getLatestLedger':
          result = {
            sequence: this.ledgerSequence,
            hash: '4a656467657248617368...',
            closedAt: new Date().toISOString(),
          };
          break;

        case 'simulateTransaction':
          // Check scenario overrides
          if (
            params?.transaction &&
            this.scenarioOverrides.has(params.transaction)
          ) {
            result = this.scenarioOverrides.get(params.transaction);
          } else {
            result = {
              status: 'SUCCESS',
              results: [{ xdr: 'AAAAAQAAAAE...' }],
              minResourceFee: '100',
              footprint: { readWrite: [], readOnly: [] },
            };
          }
          break;

        case 'sendTransaction':
          result = {
            status: 'PENDING',
            hash: 'tx_hash_' + Math.random().toString(36).substring(7),
            latestLedger: this.ledgerSequence,
          };
          break;

        case 'getLedgerEntries':
          const keys = params?.keys || [];
          const entries = keys.map((key: string) => ({
            key,
            xdr: this.ledgerEntries.get(key) || null,
            lastModifiedLedger: this.ledgerSequence - 5,
          }));
          result = { entries, latestLedger: this.ledgerSequence };
          break;

        default:
          return {
            jsonrpc,
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }

      return { jsonrpc, id, result };
    } catch (error: any) {
      return {
        jsonrpc,
        id,
        error: {
          code: -32603,
          message: `Internal mock error: ${error.message}`,
        },
      };
    }
  }
}

/**
 * Jest test suite for the DApp sandbox bridge, mock wallet,
 * serialization, contract simulation, and security isolation invariants.
 */

import {
  generateInjectedBridgeScript,
  buildSandboxedHtml,
} from '../../lib/sandbox/iframeBridge';
import {
  DEFAULT_MOCK_ACCOUNTS,
  DEFAULT_WALLET_CONFIG,
  createMockSignedTxXdr,
  VIEWPORT_PRESETS,
} from '../../lib/sandbox/mockWallet';
import {
  simulateContractInMemory,
  executeContractSimulation,
  handleIframeBridgeMessage,
} from '../../lib/sandbox/contractBridge';
import type { DappConsoleLog } from '../../lib/sandbox/types';

describe('DApp Sandbox Bridge & Mock Engine', () => {
  describe('Bridge Script Generation & Injection', () => {
    it('generates a script containing window.freighter, window.stellar, and window.soroban', () => {
      const script = generateInjectedBridgeScript(DEFAULT_WALLET_CONFIG);
      expect(typeof script).toBe('string');
      expect(script).toContain('window.freighter');
      expect(script).toContain('window.stellar');
      expect(script).toContain('window.soroban');
      expect(script).toContain('DAPP_CONSOLE_LOG');
      expect(script).toContain(DEFAULT_WALLET_CONFIG.address);
    });

    it('injects the bridge script into the HTML head', () => {
      const html = '<html><head><title>App</title></head><body>Content</body></html>';
      const result = buildSandboxedHtml(html, DEFAULT_WALLET_CONFIG);
      expect(result).toContain('id="__soroban_sandbox_bridge__"');
      expect(result.indexOf('__soroban_sandbox_bridge__')).toBeLessThan(result.indexOf('<body>'));
    });

    it('injects bridge script even if head tag is absent', () => {
      const html = '<div>Bare HTML</div>';
      const result = buildSandboxedHtml(html, DEFAULT_WALLET_CONFIG);
      expect(result).toContain('__soroban_sandbox_bridge__');
      expect(result).toContain('<div>Bare HTML</div>');
    });
  });

  describe('Mock Wallet Provider & Signing', () => {
    it('provides mock account labels and public-key-shaped addresses', () => {
      expect(DEFAULT_MOCK_ACCOUNTS.length).toBeGreaterThanOrEqual(2);
      expect(DEFAULT_MOCK_ACCOUNTS[0].address).toMatch(/^G[A-Z0-9]{55}$/);
      expect(DEFAULT_MOCK_ACCOUNTS[0].balanceXlm).toBeDefined();
    });

    it('returns a visibly invalid marker instead of pretending to sign XDR', () => {
      const xdr = 'AAAAAgAAAABnF0v7Wl0t4JkL4h5...';
      const signed = createMockSignedTxXdr(xdr, DEFAULT_WALLET_CONFIG.address);
      expect(signed).toContain(xdr);
      expect(signed).toContain('MOCK_ONLY_NOT_SIGNED');
    });

    it('throws error on empty or invalid XDR', () => {
      expect(() => createMockSignedTxXdr('', DEFAULT_WALLET_CONFIG.address)).toThrow();
    });
  });

  describe('Contract Simulation', () => {
    it('simulates hello contract function', () => {
      const res = simulateContractInMemory({
        contractId: 'C123',
        functionName: 'hello',
        args: { name: 'Soroban' },
      });
      expect(res.success).toBe(true);
      expect(res.output).toBe('Soroban');
      expect(res.gasFeeStroops).toBeGreaterThan(0);
    });

    it('simulates version contract function', () => {
      const res = simulateContractInMemory({
        contractId: 'C123',
        functionName: 'version',
      });
      expect(res.success).toBe(true);
      expect(res.output).toBe('v1.0.0');
    });

    it('simulates balance contract function', () => {
      const res = simulateContractInMemory({
        contractId: 'C123',
        functionName: 'balance',
      });
      expect(res.success).toBe(true);
      expect(res.output).toBe('10000000000');
    });

    it('rejects unknown functions instead of fabricating a contract result', () => {
      const res = simulateContractInMemory({ contractId: 'C123', functionName: 'transfer' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/No offline simulation/);
    });

    it('never sends sandbox requests to the state-changing invoke endpoint', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      } as Response);
      const result = await executeContractSimulation({
        contractId: 'C123', functionName: 'hello', args: { name: 'Test' },
      }, 'https://example.test');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.executionMode).toBe('mock');
      fetchSpy.mockRestore();
    });
  });

  describe('PostMessage Protocol Handling', () => {
    it('routes console logs to callback', () => {
      let logged: DappConsoleLog | null = null;
      const frameWindow = { postMessage: jest.fn() } as unknown as Window;
      const fakeEvent = {
        source: frameWindow,
        data: {
          source: 'soroban-playground-dapp-bridge',
          type: 'DAPP_CONSOLE_LOG',
          id: 'log_42',
          payload: {
            id: 'log_42',
            level: 'error',
            message: 'Transaction simulation reverted',
            timestamp: Date.now(),
          },
        },
      } as MessageEvent;

      handleIframeBridgeMessage(fakeEvent, frameWindow, {
        walletConfig: DEFAULT_WALLET_CONFIG,
        onConsoleLog: (l) => {
          logged = l;
        },
      });

      expect(logged).not.toBeNull();
      expect(logged?.level).toBe('error');
      expect(logged?.message).toContain('reverted');
    });

    it('rejects events with invalid or missing source', () => {
      let logged = false;
      const frameWindow = { postMessage: jest.fn() } as unknown as Window;
      const otherWindow = {} as Window;
      const fakeEvent = {
        source: otherWindow,
        data: {
          source: 'random-source',
          type: 'DAPP_CONSOLE_LOG',
          payload: { message: 'fake' },
        },
      } as MessageEvent;

      handleIframeBridgeMessage(fakeEvent, frameWindow, {
        walletConfig: DEFAULT_WALLET_CONFIG,
        onConsoleLog: () => {
          logged = true;
        },
      });

      expect(logged).toBe(false);
    });

    it('ignores malformed console payloads from the registered iframe', () => {
      let logged = false;
      const frameWindow = {} as Window;
      handleIframeBridgeMessage({
        source: frameWindow,
        data: {
          source: 'soroban-playground-dapp-bridge', type: 'DAPP_CONSOLE_LOG', id: 'log_1',
          payload: { id: 'log_1', level: 'error', message: 7, timestamp: Date.now() },
        },
      } as MessageEvent, frameWindow, {
        walletConfig: DEFAULT_WALLET_CONFIG,
        onConsoleLog: () => { logged = true; },
      });
      expect(logged).toBe(false);
    });
  });

  describe('Viewport Presets', () => {
    it('contains presets for mobile, tablet, and desktop', () => {
      expect(VIEWPORT_PRESETS.iphone).toBeDefined();
      expect(VIEWPORT_PRESETS.iphone.dimensions.width).toBe(390);
      expect(VIEWPORT_PRESETS.ipad).toBeDefined();
      expect(VIEWPORT_PRESETS.ipad.dimensions.width).toBe(820);
      expect(VIEWPORT_PRESETS.desktop).toBeDefined();
      expect(VIEWPORT_PRESETS.desktop.dimensions.width).toBe(1280);
    });
  });
});

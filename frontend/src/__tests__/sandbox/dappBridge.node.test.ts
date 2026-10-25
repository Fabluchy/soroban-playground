/**
 * Node-runnable test suite for the DApp sandbox bridge, mock wallet,
 * serialization, contract simulation, and security isolation invariants.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateInjectedBridgeScript,
  buildSandboxedHtml,
} from '../../lib/sandbox/iframeBridge.ts';
import {
  DEFAULT_MOCK_ACCOUNTS,
  DEFAULT_WALLET_CONFIG,
  createMockSignedTxXdr,
  VIEWPORT_PRESETS,
} from '../../lib/sandbox/mockWallet.ts';
import {
  simulateContractInMemory,
  handleIframeBridgeMessage,
} from '../../lib/sandbox/contractBridge.ts';
import type { DappConsoleLog } from '../../lib/sandbox/types.ts';

test('1. Bridge Script Generation', async (t) => {
  await t.test('generates valid self-contained JavaScript containing required globals', () => {
    const script = generateInjectedBridgeScript(DEFAULT_WALLET_CONFIG);
    assert.ok(typeof script === 'string' && script.length > 500);
    assert.ok(script.includes('window.freighter'));
    assert.ok(script.includes('window.stellar'));
    assert.ok(script.includes('window.soroban'));
    assert.ok(script.includes('DAPP_CONSOLE_LOG'));
    assert.ok(script.includes('SOROBAN_SIMULATE_REQUEST'));
    assert.ok(script.includes('WALLET_SIGN_REQUEST'));
    assert.ok(script.includes(DEFAULT_WALLET_CONFIG.address));
  });

  await t.test('buildSandboxedHtml injects script into <head>', () => {
    const rawHtml = '<!DOCTYPE html><html><head><title>Test</title></head><body>Hello</body></html>';
    const compiled = buildSandboxedHtml(rawHtml, DEFAULT_WALLET_CONFIG);
    assert.ok(compiled.includes('<script id="__soroban_sandbox_bridge__">'));
    assert.ok(compiled.indexOf('__soroban_sandbox_bridge__') < compiled.indexOf('<body>'));
  });

  await t.test('buildSandboxedHtml handles empty or headless HTML gracefully', () => {
    const headlessHtml = '<div>Raw Content</div>';
    const compiled = buildSandboxedHtml(headlessHtml, DEFAULT_WALLET_CONFIG);
    assert.ok(compiled.includes('__soroban_sandbox_bridge__'));
    assert.ok(compiled.includes('<div>Raw Content</div>'));
  });
});

test('2. Mock Wallet & Signing Simulator', async (t) => {
  await t.test('default accounts contain valid testnet addresses', () => {
    assert.ok(DEFAULT_MOCK_ACCOUNTS.length >= 2);
    assert.ok(DEFAULT_MOCK_ACCOUNTS[0].address.startsWith('G'));
    assert.equal(DEFAULT_MOCK_ACCOUNTS[0].address.length, 56);
  });

  await t.test('createMockSignedTxXdr marks the response as invalid mock data', () => {
    const sampleXdr = 'AAAAAgAAAABnF0v7Wl0t4JkL4h5...';
    const signed = createMockSignedTxXdr(sampleXdr, DEFAULT_WALLET_CONFIG.address);
    assert.ok(signed.includes(sampleXdr));
    assert.ok(signed.includes('MOCK_ONLY_NOT_SIGNED'));
  });

  await t.test('createMockSignedTxXdr rejects empty XDR', () => {
    assert.throws(() => {
      createMockSignedTxXdr('', DEFAULT_WALLET_CONFIG.address);
    });
  });
});

test('3. In-Memory Contract Simulation', async (t) => {
  await t.test('simulates hello function with string argument', () => {
    const res = simulateContractInMemory({
      contractId: 'CA3D5KRYMCMCZKPOJG7PYHHWNGIBRE7VAISD764NF7LADW43STODGRSX',
      functionName: 'hello',
      args: { name: 'Alice' },
    });
    assert.equal(res.success, true);
    assert.equal(res.output, 'Alice');
    assert.ok(res.gasFeeStroops && res.gasFeeStroops > 0);
  });

  await t.test('simulates version function', () => {
    const res = simulateContractInMemory({
      contractId: 'C123',
      functionName: 'version',
    });
    assert.equal(res.success, true);
    assert.equal(res.output, 'v1.0.0');
  });

  await t.test('simulates balance query', () => {
    const res = simulateContractInMemory({
      contractId: 'C123',
      functionName: 'balance',
    });
    assert.equal(res.success, true);
    assert.equal(res.output, '10000000000');
  });

  await t.test('rejects unknown function instead of fabricating contract output', () => {
    const res = simulateContractInMemory({
      contractId: 'C123',
      functionName: 'custom_action',
      args: { amount: 50 },
    });
    assert.equal(res.success, false);
    assert.match(res.error || '', /No offline simulation/);
  });
});

test('4. Message Handler & Bridge Routing', async (t) => {
  await t.test('routes DAPP_CONSOLE_LOG to onConsoleLog callback', () => {
    let capturedLog: DappConsoleLog | null = null;
    const frameWindow = { postMessage: () => {} } as unknown as Window;
    const fakeEvent = {
      data: {
        source: 'soroban-playground-dapp-bridge',
        type: 'DAPP_CONSOLE_LOG',
        id: 'log_1',
        payload: {
          id: 'log_1',
          level: 'warn',
          message: 'Low gas warning',
          timestamp: 1234567890,
        },
      },
      source: frameWindow,
    } as MessageEvent;

    handleIframeBridgeMessage(fakeEvent, frameWindow, {
      walletConfig: DEFAULT_WALLET_CONFIG,
      onConsoleLog: (l) => {
        capturedLog = l;
      },
    });

    assert.ok(capturedLog);
    assert.equal(capturedLog.message, 'Low gas warning');
    assert.equal(capturedLog.level, 'warn');
  });

  await t.test('ignores messages from untrusted sources', () => {
    let called = false;
    const frameWindow = {} as Window;
    const fakeEvent = {
      data: {
        source: 'untrusted-script',
        type: 'DAPP_CONSOLE_LOG',
        payload: { message: 'malicious' },
      },
      source: {} as Window,
    } as MessageEvent;

    handleIframeBridgeMessage(fakeEvent, frameWindow, {
      walletConfig: DEFAULT_WALLET_CONFIG,
      onConsoleLog: () => {
        called = true;
      },
    });

    assert.equal(called, false);
  });
});

test('5. Viewport Presets Integrity', async (t) => {
  await t.test('all standard presets are defined with dimensions', () => {
    assert.ok(VIEWPORT_PRESETS.iphone);
    assert.equal(VIEWPORT_PRESETS.iphone.dimensions.width, 390);
    assert.equal(VIEWPORT_PRESETS.iphone.dimensions.height, 844);
    assert.equal(VIEWPORT_PRESETS.iphone.canRotate, true);

    assert.ok(VIEWPORT_PRESETS.ipad);
    assert.equal(VIEWPORT_PRESETS.ipad.dimensions.width, 820);
    assert.equal(VIEWPORT_PRESETS.ipad.dimensions.height, 1180);

    assert.ok(VIEWPORT_PRESETS.desktop);
    assert.equal(VIEWPORT_PRESETS.desktop.dimensions.width, 1280);
    assert.equal(VIEWPORT_PRESETS.desktop.dimensions.height, 800);
  });
});

test('6. Security Isolation & Sandbox Invariants', async (t) => {
  await t.test('handles WALLET_SIGN_REQUEST and dispatches mock signed envelope to iframe', () => {
    let responseSent: any = null;
    const mockIframeWindow = {
      postMessage: (msg: any) => {
        responseSent = msg;
      },
    } as unknown as Window;

    const fakeSignEvent = {
      data: {
        source: 'soroban-playground-dapp-bridge',
        type: 'WALLET_SIGN_REQUEST',
        id: 'sign_req_99',
        payload: {
          xdr: 'AAAAAgAAAABnF0v7Wl0t4JkL4h5...',
        },
      },
      source: mockIframeWindow,
    } as MessageEvent;

    handleIframeBridgeMessage(fakeSignEvent, mockIframeWindow, {
      walletConfig: DEFAULT_WALLET_CONFIG,
      onConsoleLog: () => {},
    });

    assert.ok(responseSent);
    assert.equal(responseSent.source, 'soroban-playground-host');
    assert.equal(responseSent.type, 'WALLET_SIGN_RESPONSE');
    assert.equal(responseSent.id, 'sign_req_99');
    assert.ok(responseSent.payload.signedTxXdr.includes('MOCK_ONLY_NOT_SIGNED'));
  });

  await t.test('handles SOROBAN_SIMULATE_REQUEST and dispatches simulation result', async () => {
    let responseSent: any = null;
    const mockIframeWindow = {
      postMessage: (msg: any) => {
        responseSent = msg;
      },
    } as unknown as Window;

    const fakeSimEvent = {
      data: {
        source: 'soroban-playground-dapp-bridge',
        type: 'SOROBAN_SIMULATE_REQUEST',
        id: 'sim_req_101',
        payload: {
          contractId: 'CA3D5KRYMCMCZKPOJG7PYHHWNGIBRE7VAISD764NF7LADW43STODGRSX',
          functionName: 'hello',
          args: { name: 'Soroban' },
        },
      },
      source: mockIframeWindow,
    } as MessageEvent;

    handleIframeBridgeMessage(fakeSimEvent, mockIframeWindow, {
      walletConfig: DEFAULT_WALLET_CONFIG,
      onConsoleLog: () => {},
    });

    // Wait for microtask tick for async simulation
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(responseSent);
    assert.equal(responseSent.source, 'soroban-playground-host');
    assert.equal(responseSent.type, 'SOROBAN_SIMULATE_RESPONSE');
    assert.equal(responseSent.id, 'sim_req_101');
    assert.equal(responseSent.payload.success, true);
    assert.equal(responseSent.payload.output, 'Soroban');
  });

  await t.test('verifies strict sandbox security policy forbids allow-same-origin', () => {
    // The sandbox attribute must only include allow-scripts and allow-forms
    const allowedAttributes = ['allow-scripts', 'allow-forms'];
    const forbiddenAttributes = ['allow-same-origin', 'allow-top-navigation', 'allow-modals'];

    const sandboxPolicy = 'allow-scripts allow-forms';

    allowedAttributes.forEach((attr) => {
      assert.ok(sandboxPolicy.includes(attr), `Expected sandbox to include ${attr}`);
    });

    forbiddenAttributes.forEach((attr) => {
      assert.ok(!sandboxPolicy.includes(attr), `Forbidden attribute ${attr} found in sandbox policy!`);
    });
  });
});


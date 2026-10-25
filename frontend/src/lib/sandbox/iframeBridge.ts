/**
 * Bridge script generator injected into the sandboxed iframe preview.
 * Implements a limited Freighter-like mock (not a package-complete or signing wallet),
 * window.soroban simulation bridge, and interceptors for console output and runtime errors.
 */

import type { MockWalletConfig } from './types';

/**
 * Generates the JavaScript source string to inject into the sandboxed iframe execution context.
 */
export function generateInjectedBridgeScript(config: MockWalletConfig): string {
  const safeConfigJson = JSON.stringify({
    address: config.address,
    network: config.network,
    networkPassphrase: config.networkPassphrase,
    networkUrl: config.networkUrl,
    isConnected: config.isConnected,
    isAllowed: config.isAllowed,
    allAccounts: config.allAccounts || [],
  });

  return `
(function() {
  'use strict';
  if (window.__SOROBAN_SANDBOX_BRIDGE_INITIALIZED__) return;
  window.__SOROBAN_SANDBOX_BRIDGE_INITIALIZED__ = true;

  let walletConfig = ${safeConfigJson};
  const pendingSimReqs = Object.create(null);
  const pendingWalletReqs = Object.create(null);
  const accountWatchers = new Set();

  // Helper for safe parameter serialization (handles circular refs, Errors, BigInts)
  function safeSerialize(val) {
    try {
      if (val === undefined) return 'undefined';
      if (val === null) return 'null';
      if (typeof val === 'function') return '[Function: ' + (val.name || 'anonymous') + ']';
      if (val instanceof Error) return val.stack || (val.name + ': ' + val.message);
      if (typeof val === 'object') {
        const seen = new WeakSet();
        return JSON.stringify(val, function(k, v) {
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
          }
          if (typeof v === 'bigint') return v.toString() + 'n';
          return v;
        });
      }
      return String(val);
    } catch (e) {
      return String(val);
    }
  }

  // --- 1. CONSOLE LOG INTERCEPTOR ---
  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function(level) {
    console[level] = function() {
      const args = Array.prototype.slice.call(arguments);
      try {
        originalConsole[level].apply(console, args);
      } catch (err) {}

      try {
        const logId = 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const serializedArgs = args.map(safeSerialize);
        const joinedMessage = serializedArgs.join(' ');

        window.parent.postMessage({
          source: 'soroban-playground-dapp-bridge',
          type: 'DAPP_CONSOLE_LOG',
          id: logId,
          payload: {
            id: logId,
            level: level,
            message: joinedMessage,
            args: serializedArgs,
            timestamp: Date.now()
          }
        }, '*');
      } catch (postErr) {}
    };
  });

  // --- 2. GLOBAL RUNTIME ERROR CAPTURE ---
  window.addEventListener('error', function(event) {
    try {
      const logId = 'err_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const errMsg = event.error ? (event.error.stack || event.error.message) : (event.message || 'Script error');
      window.parent.postMessage({
        source: 'soroban-playground-dapp-bridge',
        type: 'DAPP_CONSOLE_LOG',
        id: logId,
        payload: {
          id: logId,
          level: 'error',
          message: 'Unhandled Error: ' + errMsg,
          timestamp: Date.now(),
          stack: event.error && event.error.stack
        }
      }, '*');
    } catch (e) {}
  });

  window.addEventListener('unhandledrejection', function(event) {
    try {
      const logId = 'rejection_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const reasonMsg = event.reason ? (event.reason.stack || event.reason.message || safeSerialize(event.reason)) : 'Unhandled Promise Rejection';
      window.parent.postMessage({
        source: 'soroban-playground-dapp-bridge',
        type: 'DAPP_CONSOLE_LOG',
        id: logId,
        payload: {
          id: logId,
          level: 'error',
          message: 'Unhandled Promise Rejection: ' + reasonMsg,
          timestamp: Date.now()
        }
      }, '*');
    } catch (e) {}
  });

  // --- 3. VIRTUAL WALLET PROVIDER (window.freighter & window.stellar) ---
  const virtualFreighterProvider = {
    isConnected: function() {
      return Promise.resolve({ isConnected: !!walletConfig.isConnected });
    },
    isAllowed: function() {
      return Promise.resolve({ isAllowed: !!walletConfig.isAllowed });
    },
    requestAccess: function() {
      if (!walletConfig.isConnected) {
        return Promise.resolve({ error: 'User rejected wallet connection' });
      }
      return Promise.resolve({ address: walletConfig.address });
    },
    getAddress: function() {
      if (!walletConfig.isConnected) {
        return Promise.resolve({ error: 'Wallet not connected' });
      }
      return Promise.resolve({ address: walletConfig.address });
    },
    getPublicKey: function() {
      if (!walletConfig.isConnected) {
        return Promise.reject(new Error('Freighter wallet not connected'));
      }
      return Promise.resolve(walletConfig.address);
    },
    getNetwork: function() {
      return Promise.resolve(walletConfig.network || 'TESTNET');
    },
    getNetworkDetails: function() {
      return Promise.resolve({
        network: walletConfig.network || 'TESTNET',
        networkUrl: walletConfig.networkUrl || 'https://soroban-testnet.stellar.org',
        networkPassphrase: walletConfig.networkPassphrase || 'Test SDF Network ; November 2015',
      });
    },
    signTransaction: function(xdr, opts) {
      if (!walletConfig.isConnected) {
        return Promise.reject(new Error('Freighter wallet not connected'));
      }
      return new Promise(function(resolve, reject) {
        const reqId = 'sign_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const timer = setTimeout(function() {
          delete pendingWalletReqs[reqId];
          // Fallback simulation: append mock signature envelope decoration
          resolve(xdr + '.MOCK_ONLY_NOT_SIGNED:' + walletConfig.address.slice(0, 8));
        }, 1200);

        pendingWalletReqs[reqId] = function(res) {
          clearTimeout(timer);
          if (res.error) reject(new Error(res.error));
          else resolve(res.signedTxXdr || (xdr + '.MOCK_ONLY_NOT_SIGNED:' + walletConfig.address.slice(0, 8)));
        };

        window.parent.postMessage({
          source: 'soroban-playground-dapp-bridge',
          type: 'WALLET_SIGN_REQUEST',
          id: reqId,
          payload: { xdr: xdr, options: opts || {} }
        }, '*');
      });
    },
    signAuthEntry: function(entryXdr, opts) {
      if (!walletConfig.isConnected) {
        return Promise.reject(new Error('Freighter wallet not connected'));
      }
      return Promise.resolve(entryXdr + '.MOCK_ONLY_NOT_SIGNED:' + walletConfig.address.slice(0, 8));
    },
    WatchWalletChanges: function() {
      const watchers = new Set();
      return {
        watch: function(callback) {
          if (typeof callback !== 'function') return;
          watchers.add(callback);
          accountWatchers.add(callback);
          callback({ address: walletConfig.address, network: walletConfig.network });
        },
        close: function() {
          watchers.forEach(function(callback) { accountWatchers.delete(callback); });
          watchers.clear();
        }
      };
    }
  };

  // Bind to window.freighter and window.stellar
  window.freighter = virtualFreighterProvider;
  window.stellar = virtualFreighterProvider;

  // --- 4. SOROBAN CONTRACT SIMULATION BRIDGE (window.soroban) ---
  window.soroban = {
    simulate: function(req) {
      return new Promise(function(resolve, reject) {
        if (!req || !req.contractId || !req.functionName) {
          return reject(new Error('Invalid simulate request: contractId and functionName required'));
        }
        const reqId = 'sim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const timer = setTimeout(function() {
          delete pendingSimReqs[reqId];
          reject(new Error('Simulation request timed out after 10000ms'));
        }, 10000);

        pendingSimReqs[reqId] = function(res) {
          clearTimeout(timer);
          if (res && res.success === false) {
            reject(new Error(res.error || res.message || 'Simulation execution failed'));
          } else {
            resolve(res);
          }
        };

        window.parent.postMessage({
          source: 'soroban-playground-dapp-bridge',
          type: 'SOROBAN_SIMULATE_REQUEST',
          id: reqId,
          payload: req
        }, '*');
      });
    },
    invoke: function(req) {
      return this.simulate(req);
    }
  };

  // --- 5. HOST POSTMESSAGE EVENT LISTENER ---
  window.addEventListener('message', function(event) {
    const data = event.data;
    if (event.source !== window.parent || !data || data.source !== 'soroban-playground-host') return;

    if (data.type === 'SOROBAN_SIMULATE_RESPONSE' && data.id && pendingSimReqs[data.id]) {
      const handler = pendingSimReqs[data.id];
      delete pendingSimReqs[data.id];
      handler(data.payload);
    } else if (data.type === 'WALLET_SIGN_RESPONSE' && data.id && pendingWalletReqs[data.id]) {
      const handler = pendingWalletReqs[data.id];
      delete pendingWalletReqs[data.id];
      handler(data.payload);
    } else if (data.type === 'PARENT_CONFIG_UPDATE' && data.payload) {
      walletConfig = Object.assign({}, walletConfig, data.payload);
      accountWatchers.forEach(function(cb) {
        try {
          cb({ address: walletConfig.address, network: walletConfig.network });
        } catch (e) {}
      });
    }
  });

  // Notify parent container that sandbox bridge has completed initialization
  try {
    window.parent.postMessage({
      source: 'soroban-playground-dapp-bridge',
      type: 'SANDBOX_READY',
      id: 'init_' + Date.now(),
      payload: { ready: true, address: walletConfig.address }
    }, '*');
  } catch (e) {}
})();
`;
}

/**
 * Compiles complete HTML source for iframe srcdoc, inserting the bridge script
 * into <head> or at the document beginning before user scripts execute.
 */
export function buildSandboxedHtml(rawHtml: string, walletConfig: MockWalletConfig): string {
  const bridgeScript = `<script id="__soroban_sandbox_bridge__">${generateInjectedBridgeScript(walletConfig)}</script>`;

  if (!rawHtml || typeof rawHtml !== 'string') {
    return `<!DOCTYPE html><html><head>${bridgeScript}</head><body></body></html>`;
  }

  // Insert immediately after <head> if present
  if (/<head[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head[^>]*>/i, (match) => `${match}\n  ${bridgeScript}`);
  }

  // Insert after <!DOCTYPE> or <html> if head is absent
  if (/<html[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<html[^>]*>/i, (match) => `${match}\n<head>${bridgeScript}</head>`);
  }

  // Fallback: prepend bridge script
  return `${bridgeScript}\n${rawHtml}`;
}

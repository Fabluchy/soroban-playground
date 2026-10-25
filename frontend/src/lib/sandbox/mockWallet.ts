/**
 * Default mock wallet configurations, preset accounts, and simulated cryptographic helpers
 * for testing DApps inside the sandboxed preview iframe.
 */

import type { MockWalletAccount, MockWalletConfig, ViewportPresetConfig } from './types';

export const DEFAULT_MOCK_ACCOUNTS: MockWalletAccount[] = [
  {
    address: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGONUCTXOTMIW2ELW5P',
    name: 'Playground Dev Account',
    balanceXlm: '10,000.00',
  },
  {
    address: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    name: 'Secondary Test Account',
    balanceXlm: '2,500.00',
  },
  {
    address: 'GCKAZODDO3O2IUQJ7V26KZG4S2DYXQW2E6PMR2VGYX7VHQ4L5Z7GZ6T6',
    name: 'DAO Treasury Mock',
    balanceXlm: '150,000.00',
  },
];

export const DEFAULT_WALLET_CONFIG: MockWalletConfig = {
  address: DEFAULT_MOCK_ACCOUNTS[0].address,
  network: 'TESTNET',
  networkPassphrase: 'Test SDF Network ; November 2015',
  networkUrl: 'https://soroban-testnet.stellar.org',
  isConnected: true,
  isAllowed: true,
  allAccounts: DEFAULT_MOCK_ACCOUNTS,
};

export const VIEWPORT_PRESETS: Record<string, ViewportPresetConfig> = {
  iphone: {
    id: 'iphone',
    name: 'iPhone 15 / 16',
    dimensions: { width: 390, height: 844 },
    canRotate: true,
    hasDeviceFrame: true,
  },
  ipad: {
    id: 'ipad',
    name: 'iPad Air / Pro',
    dimensions: { width: 820, height: 1180 },
    canRotate: true,
    hasDeviceFrame: true,
  },
  desktop: {
    id: 'desktop',
    name: 'Desktop Preview',
    dimensions: { width: 1280, height: 800 },
    canRotate: false,
    hasDeviceFrame: false,
  },
  responsive: {
    id: 'responsive',
    name: 'Responsive Canvas',
    dimensions: { width: 680, height: 520 },
    canRotate: false,
    hasDeviceFrame: false,
  },
};

/**
 * Returns an intentionally invalid marker for UI-only mock signing.
 * It does not validate or sign XDR and must never be submitted to a network.
 */
export function createMockSignedTxXdr(xdr: string, accountAddress: string): string {
  if (!xdr || typeof xdr !== 'string') {
    throw new Error('Invalid transaction XDR provided for mock signing');
  }
  return `${xdr.trim()}.MOCK_ONLY_NOT_SIGNED:${accountAddress.slice(0, 8)}`;
}

/**
 * Default interactive sample DApp template for developers opening the sandbox preview.
 */
export const DEFAULT_SAMPLE_DAPP = {
  name: 'Soroban Counter & Wallet Integration',
  description: 'Interactive demo testing window.freighter and window.soroban integration',
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DApp Integration Sandbox</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(255, 255, 255, 0.04);
      --border: rgba(255, 255, 255, 0.1);
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 540px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
      backdrop-filter: blur(12px);
    }
    h1 { font-size: 1.25rem; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    p.desc { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .badge.disconnected {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .info-row { display: flex; justify-content: space-between; font-size: 0.82rem; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .info-label { color: var(--text-muted); }
    .info-value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 500; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    button {
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--accent);
      color: white;
      font-weight: 600;
      font-size: 0.82rem;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    button:hover { background: var(--accent-hover); }
    button.secondary { background: rgba(255, 255, 255, 0.08); }
    button.secondary:hover { background: rgba(255, 255, 255, 0.14); }
    .log-box {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      background: rgba(0, 0, 0, 0.4);
      padding: 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      max-height: 130px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: #cbd5e1;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <h1>🚀 DApp Sandbox</h1>
          <p class="desc">Communicating directly with playground contract simulation & virtual wallet</p>
        </div>
        <span id="walletBadge" class="badge">● Connected</span>
      </div>

      <div class="info-row">
        <span class="info-label">Wallet Address</span>
        <span id="accountAddress" class="info-value">Detecting...</span>
      </div>
      <div class="info-row">
        <span class="info-label">Network</span>
        <span id="networkName" class="info-value">TESTNET</span>
      </div>
      <div class="info-row">
        <span class="info-label">Soroban Provider</span>
        <span class="info-value" style="color: #818cf8;">window.soroban (Active)</span>
      </div>

      <div class="actions">
        <button id="btnConnect" class="secondary">Sync Wallet</button>
        <button id="btnSign">Sign Mock Tx</button>
      </div>
      <div class="actions" style="margin-top: 8px;">
        <button id="btnInvoke" class="secondary">Simulate Contract Call</button>
        <button id="btnLog" class="secondary">Emit Console Test</button>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size: 0.95rem; font-weight: 600; margin-bottom: 8px;">DApp Activity Feed</h2>
      <div id="outputLog" class="log-box">[Ready] DApp initialized inside sandbox container.</div>
    </div>
  </div>

  <script>
    const logBox = document.getElementById('outputLog');
    const accountEl = document.getElementById('accountAddress');
    const networkEl = document.getElementById('networkName');
    const badgeEl = document.getElementById('walletBadge');

    function appendFeed(msg) {
      logBox.textContent = \`[\${new Date().toLocaleTimeString()}] \${msg}\\n\` + logBox.textContent;
    }

    async function initWallet() {
      try {
        if (window.freighter && typeof window.freighter.isConnected === 'function') {
          const connected = await window.freighter.isConnected();
          if (connected) {
            const addr = await window.freighter.getPublicKey();
            const net = await window.freighter.getNetwork();
            accountEl.textContent = addr ? (addr.slice(0, 6) + '...' + addr.slice(-4)) : 'None';
            networkEl.textContent = net || 'TESTNET';
            badgeEl.className = 'badge';
            badgeEl.textContent = '● Connected';
            console.log('Virtual Freighter wallet connected successfully. Address:', addr);
            appendFeed('Connected to mock wallet: ' + addr.slice(0, 8) + '...');
          } else {
            badgeEl.className = 'badge disconnected';
            badgeEl.textContent = '○ Disconnected';
            accountEl.textContent = 'Disconnected';
            console.warn('Freighter wallet reported disconnected.');
          }
        } else {
          console.error('window.freighter provider not detected.');
        }
      } catch (err) {
        console.error('Error initializing wallet:', err);
      }
    }

    document.getElementById('btnConnect').addEventListener('click', async () => {
      console.info('DApp requested wallet sync via window.freighter.requestAccess()');
      try {
        const res = await window.freighter.requestAccess();
        if (res && res.address) {
          appendFeed('Access granted for ' + res.address.slice(0, 8) + '...');
          initWallet();
        }
      } catch (e) {
        console.error('Request access rejected:', e.message);
      }
    });

    document.getElementById('btnSign').addEventListener('click', async () => {
      console.log('Initiating mock transaction signing...');
      const sampleTxXdr = 'AAAAAgAAAABnF0v7Wl0t4Jk...';
      try {
        const signed = await window.freighter.signTransaction(sampleTxXdr, {
          networkPassphrase: 'Test SDF Network ; November 2015'
        });
        appendFeed('Mock signing response (not valid transaction XDR): ' + signed.slice(0, 24) + '...');
        console.info('Mock signature marker returned; it cannot authorize or submit a transaction.');
      } catch (e) {
        console.error('Signing failed:', e.message);
      }
    });

    document.getElementById('btnInvoke').addEventListener('click', async () => {
      console.info('Invoking contract simulation via window.soroban.simulate()...');
      appendFeed('Simulating contract: hello("Developer")...');
      try {
        if (window.soroban) {
          const result = await window.soroban.simulate({
            contractId: 'CA3D5KRYMCMCZKPOJG7PYHHWNGIBRE7VAISD764NF7LADW43STODGRSX',
            functionName: 'hello',
            args: { name: 'Soroban Developer' }
          });
          appendFeed('Simulation output: ' + JSON.stringify(result.output));
          console.log('Contract simulation result:', result);
        } else {
          console.warn('window.soroban simulation bridge not initialized');
        }
      } catch (e) {
        console.error('Simulation call failed:', e.message);
      }
    });

    document.getElementById('btnLog').addEventListener('click', () => {
      console.log('Normal info log at ' + new Date().toISOString());
      console.warn('Sample warning: Contract gas fee approaching limit threshold (120,000 stroops)');
      console.error('Simulated error: Network latency spike detected (450ms)');
      appendFeed('Emitted sample log, warn, and error to parent console.');
    });

    // Auto-init on load
    window.addEventListener('load', initWallet);
  </script>
</body>
</html>`,
};

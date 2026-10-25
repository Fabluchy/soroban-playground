'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Smartphone,
  Tablet,
  Monitor,
  Maximize2,
  RotateCw,
  RefreshCw,
  Terminal,
  ShieldCheck,
  Search,
  Trash2,
  Copy,
  Check,
  Pause,
  AlertTriangle,
  AlertCircle,
  Info,
  Wallet,
  Play,
  ChevronDown,
} from 'lucide-react';
import {
  DappConsoleLog,
  MockWalletConfig,
  ViewportOrientation,
  ViewportPreset,
  ViewportScale,
} from '@/lib/sandbox/types';
import {
  DEFAULT_MOCK_ACCOUNTS,
  DEFAULT_SAMPLE_DAPP,
  DEFAULT_WALLET_CONFIG,
  VIEWPORT_PRESETS,
} from '@/lib/sandbox/mockWallet';
import { buildSandboxedHtml } from '@/lib/sandbox/iframeBridge';
import { handleIframeBridgeMessage } from '@/lib/sandbox/contractBridge';

export interface DappIframeContainerProps {
  dappHtml?: string;
  initialPreset?: ViewportPreset;
  apiBaseUrl?: string;
  className?: string;
  onLogReceived?: (log: DappConsoleLog) => void;
}

const MAX_CONSOLE_LOGS = 1000;

export default function DappIframeContainer({
  dappHtml = DEFAULT_SAMPLE_DAPP.html,
  initialPreset = 'iphone',
  apiBaseUrl,
  className = '',
  onLogReceived,
}: DappIframeContainerProps) {
  // --- Viewport State ---
  const [preset, setPreset] = useState<ViewportPreset>(initialPreset);
  const [orientation, setOrientation] = useState<ViewportOrientation>('portrait');
  const [scale, setScale] = useState<ViewportScale>(1);
  const [customWidth, setCustomWidth] = useState(680);
  const [customHeight, setCustomHeight] = useState(520);
  const [activeTab, setActiveTab] = useState<'preview' | 'console' | 'split'>('split');
  const [reloadKey, setReloadKey] = useState(0);
  const [fitScale, setFitScale] = useState(1);

  // --- Wallet Mock State ---
  const [walletConfig, setWalletConfig] = useState<MockWalletConfig>(DEFAULT_WALLET_CONFIG);
  const [selectedAccountAddress, setSelectedAccountAddress] = useState(walletConfig.address);

  // --- Console State ---
  const [logs, setLogs] = useState<DappConsoleLog[]>([]);
  const [logFilter, setLogFilter] = useState<'all' | 'log' | 'warn' | 'error'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isConsolePaused, setIsConsolePaused] = useState(false);
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const consoleBottomRef = useRef<HTMLDivElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);

  // Compute actual dimensions based on preset and orientation
  const currentDimensions = useMemo(() => {
    if (preset === 'responsive') {
      return { width: customWidth, height: customHeight };
    }
    const config = VIEWPORT_PRESETS[preset] || VIEWPORT_PRESETS.desktop;
    if (config.canRotate && orientation === 'landscape') {
      return { width: config.dimensions.height, height: config.dimensions.width };
    }
    return config.dimensions;
  }, [preset, orientation, customWidth, customHeight]);

  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const updateFitScale = () => {
      const availableWidth = Math.max(0, viewport.clientWidth - 48);
      const availableHeight = Math.max(0, viewport.clientHeight - 48);
      const hasFrame = VIEWPORT_PRESETS[preset]?.hasDeviceFrame === true;
      const frameWidth = currentDimensions.width + (hasFrame ? 24 : 0);
      const frameHeight = currentDimensions.height + (hasFrame ? 24 : 0);
      if (!availableWidth || !availableHeight) {
        setFitScale(1);
        return;
      }
      setFitScale(Math.min(1, availableWidth / frameWidth, availableHeight / frameHeight));
    };
    updateFitScale();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateFitScale) : null;
    observer?.observe(viewport);
    window.addEventListener('resize', updateFitScale);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateFitScale);
    };
  }, [activeTab, currentDimensions.height, currentDimensions.width, preset]);

  // Build sandboxed HTML with injected bridge script
  const compiledSrcDoc = useMemo(() => {
    return buildSandboxedHtml(dappHtml, walletConfig);
  }, [dappHtml, walletConfig, reloadKey]);

  // Keep a bounded immutable log history; paused logs are intentionally dropped.
  const handleIncomingLog = useCallback(
    (log: DappConsoleLog) => {
      if (isConsolePaused) return;
      setLogs((prev) => {
        const next = [...prev, log];
        if (next.length > MAX_CONSOLE_LOGS) {
          return next.slice(next.length - MAX_CONSOLE_LOGS);
        }
        return next;
      });
      if (onLogReceived) {
        onLogReceived(log);
      }
    },
    [isConsolePaused, onLogReceived],
  );

  // postMessage router
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const contentWin = iframeRef.current?.contentWindow || null;
      handleIframeBridgeMessage(event, contentWin, {
        walletConfig,
        onConsoleLog: handleIncomingLog,
        apiBaseUrl,
      });
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [walletConfig, handleIncomingLog, apiBaseUrl]);

  // Auto-scroll console to latest message
  useEffect(() => {
    if (activeTab === 'console' || activeTab === 'split') {
      consoleBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, activeTab]);

  // Filtered console logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (logFilter === 'log' && log.level !== 'log' && log.level !== 'info') return false;
      if (logFilter === 'warn' && log.level !== 'warn') return false;
      if (logFilter === 'error' && log.level !== 'error') return false;

      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        return (
          log.message.toLowerCase().includes(query) ||
          (log.stack && log.stack.toLowerCase().includes(query))
        );
      }
      return true;
    });
  }, [logs, logFilter, searchQuery]);

  const errorCount = useMemo(() => logs.filter((l) => l.level === 'error').length, [logs]);
  const warnCount = useMemo(() => logs.filter((l) => l.level === 'warn').length, [logs]);

  // Wallet Controls
  const toggleWalletConnection = () => {
    const nextConnected = !walletConfig.isConnected;
    const nextConfig = {
      ...walletConfig,
      isConnected: nextConnected,
      isAllowed: nextConnected,
    };
    setWalletConfig(nextConfig);

    // Notify iframe via postMessage
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: 'soroban-playground-host',
        type: 'PARENT_CONFIG_UPDATE',
        id: `cfg_${Date.now()}`,
        payload: nextConfig,
      },
      '*',
    );
  };

  const changeAccount = (address: string) => {
    setSelectedAccountAddress(address);
    const nextConfig = { ...walletConfig, address };
    setWalletConfig(nextConfig);

    iframeRef.current?.contentWindow?.postMessage(
      {
        source: 'soroban-playground-host',
        type: 'PARENT_CONFIG_UPDATE',
        id: `cfg_${Date.now()}`,
        payload: nextConfig,
      },
      '*',
    );
  };

  const handleCopyLogs = () => {
    const text = logs
      .map(
        (l) =>
          `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}`,
      )
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopiedLogId('all');
    setTimeout(() => setCopiedLogId(null), 2000);
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  return (
    <div
      className={`flex flex-col h-full w-full rounded-2xl border border-white/10 bg-slate-950/80 backdrop-blur-xl shadow-2xl overflow-hidden text-slate-100 ${className}`}
      data-testid="dapp-iframe-container"
    >
      {/* --- Top Control Bar --- */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-white/8 bg-slate-900/60">
        {/* Left: Viewport Presets */}
        <div className="flex items-center gap-1.5 bg-slate-950/60 p-1 rounded-xl border border-white/6">
          <button
            onClick={() => setPreset('iphone')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              preset === 'iphone'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
            title="iPhone 15/16 (390 x 844)"
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>iPhone</span>
          </button>

          <button
            onClick={() => setPreset('ipad')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              preset === 'ipad'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
            title="iPad Air / Pro (820 x 1180)"
          >
            <Tablet className="w-3.5 h-3.5" />
            <span>iPad</span>
          </button>

          <button
            onClick={() => setPreset('desktop')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              preset === 'desktop'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
            title="Desktop 100% (1280 x 800)"
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>Desktop</span>
          </button>

          <button
            onClick={() => setPreset('responsive')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              preset === 'responsive'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
            title="Custom Responsive Size"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Custom</span>
          </button>
        </div>

        {/* Middle: Orientation & Dimensions */}
        <div className="flex items-center gap-2">
          {VIEWPORT_PRESETS[preset]?.canRotate && (
            <button
              onClick={() =>
                setOrientation((prev) => (prev === 'portrait' ? 'landscape' : 'portrait'))
              }
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/8 text-slate-300 hover:bg-white/10 transition"
              title="Toggle Orientation (Portrait / Landscape)"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span className="capitalize">{orientation}</span>
            </button>
          )}

          {preset === 'responsive' ? (
            <div className="flex items-center gap-1.5 text-xs text-slate-400 bg-white/5 px-2 py-1 rounded-lg border border-white/8">
              <input
                type="number"
                value={customWidth}
                onChange={(e) => setCustomWidth(Math.max(300, Number(e.target.value)))}
                className="w-14 bg-transparent text-slate-200 font-mono text-center focus:outline-none"
                aria-label="Viewport width"
              />
              <span>x</span>
              <input
                type="number"
                value={customHeight}
                onChange={(e) => setCustomHeight(Math.max(300, Number(e.target.value)))}
                className="w-14 bg-transparent text-slate-200 font-mono text-center focus:outline-none"
                aria-label="Viewport height"
              />
              <span>px</span>
            </div>
          ) : (
            <span className="text-xs font-mono text-slate-400 bg-white/5 px-2.5 py-1 rounded-lg border border-white/8">
              {currentDimensions.width} x {currentDimensions.height} px
            </span>
          )}

          {/* Scale Selector */}
          <select
            value={scale}
            onChange={(e) => setScale(e.target.value === 'fit' ? 'fit' : Number(e.target.value) as ViewportScale)}
            className="bg-white/5 border border-white/8 rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none cursor-pointer"
            aria-label="Viewport zoom scale"
          >
            <option value={1} className="bg-slate-900">100%</option>
            <option value={0.75} className="bg-slate-900">75%</option>
            <option value={0.5} className="bg-slate-900">50%</option>
            <option value="fit" className="bg-slate-900">Fit</option>
          </select>

          {/* Refresh IFrame */}
          <button
            onClick={() => setReloadKey((prev) => prev + 1)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 bg-white/5 border border-white/8 hover:bg-white/10 transition"
            title="Reload DApp Preview"
            aria-label="Reload preview"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Right: Security Badge & View Tabs */}
        <div className="flex items-center gap-2">
          {/* Sandbox Security Badge */}
          <div
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
            title="Strict Origin Isolation: sandbox='allow-scripts allow-forms' without allow-same-origin"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Isolated Sandbox</span>
          </div>

          {/* View Tab Selector */}
          <div className="flex items-center bg-slate-950/60 p-1 rounded-xl border border-white/6 text-xs">
            <button
              onClick={() => setActiveTab('preview')}
              className={`px-3 py-1 rounded-lg transition ${
                activeTab === 'preview'
                  ? 'bg-indigo-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Preview
            </button>
            <button
              onClick={() => setActiveTab('split')}
              className={`px-3 py-1 rounded-lg transition ${
                activeTab === 'split'
                  ? 'bg-indigo-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Split View
            </button>
            <button
              onClick={() => setActiveTab('console')}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg transition ${
                activeTab === 'console'
                  ? 'bg-indigo-600 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Terminal className="w-3 h-3" />
              <span>Console</span>
              {(errorCount > 0 || warnCount > 0) && (
                <span
                  className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                    errorCount > 0 ? 'bg-rose-500/80 text-white' : 'bg-amber-500/80 text-white'
                  }`}
                >
                  {errorCount + warnCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* --- Virtual Wallet Bar --- */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 bg-slate-900/40 border-b border-white/6 text-xs">
        <div className="flex items-center gap-2">
          <Wallet className="w-3.5 h-3.5 text-indigo-400" />
          <span className="font-semibold text-slate-300">Virtual Wallet:</span>
          <button
            onClick={toggleWalletConnection}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border transition ${
              walletConfig.isConnected
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25'
                : 'bg-rose-500/15 text-rose-400 border-rose-500/30 hover:bg-rose-500/25'
            }`}
            title="Click to toggle wallet connection state"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                walletConfig.isConnected ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
            />
            <span>{walletConfig.isConnected ? 'Connected' : 'Disconnected'}</span>
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Account Selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Account:</span>
            <select
              value={selectedAccountAddress}
              onChange={(e) => changeAccount(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-md px-2 py-0.5 text-slate-200 font-mono text-[11px] focus:outline-none"
              aria-label="Mock wallet account"
            >
              {DEFAULT_MOCK_ACCOUNTS.map((acc) => (
                <option key={acc.address} value={acc.address} className="bg-slate-900">
                  {acc.name} ({acc.address.slice(0, 4)}...{acc.address.slice(-4)})
                </option>
              ))}
            </select>
          </div>

          <span className="text-slate-500">|</span>
          <span className="text-slate-400">
            Network: <strong className="text-indigo-300 font-semibold">{walletConfig.network}</strong>
          </span>
        </div>
      </div>

      {/* --- Main Workspace (Preview & Console) --- */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden bg-slate-950/90">
        {/* Preview Frame */}
        {(activeTab === 'preview' || activeTab === 'split') && (
          <div
            ref={previewViewportRef}
            className={`flex-1 min-h-0 overflow-auto flex items-center justify-center p-6 bg-radial from-slate-900/50 to-slate-950/90 ${
              activeTab === 'split' ? 'lg:border-r border-b lg:border-b-0 border-white/8' : ''
            }`}
          >
            <div
              style={{
                transform: `scale(${scale === 'fit' ? fitScale : scale})`,
                transformOrigin: 'top center',
                transition: 'transform 0.2s ease, width 0.2s ease, height 0.2s ease',
              }}
              className="flex items-center justify-center"
            >
              {/* iPhone / iPad Device Frame */}
              {VIEWPORT_PRESETS[preset]?.hasDeviceFrame ? (
                <div
                  style={{
                    width: currentDimensions.width + 24,
                    height: currentDimensions.height + 24,
                  }}
                  className="relative p-3 rounded-[44px] bg-slate-900 border-[6px] border-slate-700/80 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.7)] flex flex-col items-center justify-center"
                >
                  {/* Dynamic Island / Camera Notch */}
                  <div className="absolute top-4 w-24 h-5 bg-black rounded-full z-10 flex items-center justify-center">
                    <div className="w-2.5 h-2.5 bg-slate-800 rounded-full mr-2" />
                  </div>

                  <iframe
                    ref={iframeRef}
                    key={reloadKey}
                    srcDoc={compiledSrcDoc}
                    sandbox="allow-scripts allow-forms"
                    style={{
                      width: currentDimensions.width,
                      height: currentDimensions.height,
                    }}
                    className="rounded-[32px] bg-slate-950 border-0 overflow-hidden"
                    title="Sandboxed DApp Preview"
                    data-testid="sandboxed-dapp-iframe"
                  />
                </div>
              ) : (
                /* Desktop / Responsive Frame */
                <div
                  style={{
                    width: preset === 'desktop' ? '100%' : currentDimensions.width,
                    height: currentDimensions.height,
                    maxWidth: currentDimensions.width,
                  }}
                  className="w-full rounded-xl overflow-hidden border border-white/10 shadow-2xl bg-slate-900 flex flex-col"
                >
                  {/* Browser Window Titlebar */}
                  <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 border-b border-white/8">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                    </div>
                    <div className="flex-1 mx-4 px-3 py-0.5 rounded-md bg-black/40 text-[11px] font-mono text-slate-400 text-center truncate">
                      sandbox://preview.local/dapp
                    </div>
                  </div>

                  <iframe
                    ref={iframeRef}
                    key={reloadKey}
                    srcDoc={compiledSrcDoc}
                    sandbox="allow-scripts allow-forms"
                    className="w-full flex-1 border-0 bg-slate-950"
                    title="Sandboxed DApp Preview"
                    data-testid="sandboxed-dapp-iframe"
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Console Drawer / Tab */}
        {(activeTab === 'console' || activeTab === 'split') && (
          <div
            className={`flex flex-col bg-slate-950 overflow-hidden ${
              activeTab === 'split' ? 'w-full lg:w-[420px] xl:w-[480px] h-64 lg:h-auto' : 'flex-1'
            }`}
          >
            {/* Console Toolbar */}
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-white/8 bg-slate-900/60 text-xs">
              <div className="flex items-center gap-1 bg-slate-950/80 p-0.5 rounded-lg border border-white/6">
                <button
                  onClick={() => setLogFilter('all')}
                  className={`px-2 py-1 rounded text-[11px] font-medium transition ${
                    logFilter === 'all'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  All ({logs.length})
                </button>
                <button
                  onClick={() => setLogFilter('log')}
                  className={`px-2 py-1 rounded text-[11px] font-medium transition ${
                    logFilter === 'log'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Logs
                </button>
                <button
                  onClick={() => setLogFilter('warn')}
                  className={`px-2 py-1 rounded text-[11px] font-medium transition ${
                    logFilter === 'warn'
                      ? 'bg-amber-500/20 text-amber-300 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Warn ({warnCount})
                </button>
                <button
                  onClick={() => setLogFilter('error')}
                  className={`px-2 py-1 rounded text-[11px] font-medium transition ${
                    logFilter === 'error'
                      ? 'bg-rose-500/20 text-rose-300 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Error ({errorCount})
                </button>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIsConsolePaused((paused) => !paused)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 bg-white/5 hover:bg-white/10 transition"
                  title={isConsolePaused ? 'Resume console ingestion' : 'Pause console ingestion'}
                  aria-label={isConsolePaused ? 'Resume console ingestion' : 'Pause console ingestion'}
                  aria-pressed={isConsolePaused}
                >
                  {isConsolePaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={handleCopyLogs}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 bg-white/5 hover:bg-white/10 transition"
                  title="Copy logs to clipboard"
                  aria-label="Copy logs"
                >
                  {copiedLogId === 'all' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>

                <button
                  onClick={handleClearLogs}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 bg-white/5 hover:bg-white/10 transition"
                  title="Clear console"
                  aria-label="Clear console"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Search Filter Input */}
            <div className="px-3 py-1.5 border-b border-white/6 bg-slate-900/40">
              <div className="relative flex items-center">
                <Search className="w-3 h-3 text-slate-500 absolute left-2.5 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter console output..."
                  className="w-full bg-slate-950/80 border border-white/8 rounded-md pl-7 pr-3 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {/* Console Log List */}
            <div className="flex-1 min-h-0 overflow-y-auto p-2 font-mono text-[11px] space-y-1">
              {filteredLogs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-500 p-6 text-center">
                  <Terminal className="w-6 h-6 mb-2 opacity-50" />
                  <p className="font-sans text-xs">No console logs captured yet</p>
                  <p className="font-sans text-[11px] text-slate-600 mt-1">
                    DApp console output and errors will appear here in real time.
                  </p>
                </div>
              ) : (
                filteredLogs.map((log) => {
                  const time = new Date(log.timestamp).toLocaleTimeString();
                  let levelBadge = (
                    <span className="text-slate-400 flex items-center gap-1">
                      <Info className="w-3 h-3 text-sky-400" />
                    </span>
                  );
                  let rowStyle = 'text-slate-300 border-white/4 bg-white/2';

                  if (log.level === 'warn') {
                    levelBadge = (
                      <span className="text-amber-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                      </span>
                    );
                    rowStyle = 'text-amber-200 border-amber-500/20 bg-amber-500/5';
                  } else if (log.level === 'error') {
                    levelBadge = (
                      <span className="text-rose-400 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                      </span>
                    );
                    rowStyle = 'text-rose-200 border-rose-500/20 bg-rose-500/5';
                  }

                  return (
                    <div
                      key={log.id}
                      className={`p-1.5 rounded border transition-all ${rowStyle}`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-slate-500 select-none text-[10px] pt-0.5">
                          {time}
                        </span>
                        {levelBadge}
                        <div className="flex-1 break-words whitespace-pre-wrap">
                          {log.message}
                          {log.stack && (
                            <pre className="mt-1 text-[10px] text-rose-300/80 overflow-x-auto">
                              {log.stack}
                            </pre>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={consoleBottomRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

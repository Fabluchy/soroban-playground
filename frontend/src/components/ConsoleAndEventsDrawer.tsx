"use client";

import React, { useState } from "react";
import { Terminal, Activity, SquareTerminal } from "lucide-react";
import Console from "@/components/Console";
import { EventsPanel } from "@/components/EventsPanel";
import { SorobanCliTerminal } from "@/components/SorobanCliTerminal";

interface ConsoleAndEventsDrawerProps {
  logs: string[];
  baseLineNumber?: number;
  droppedMessages?: number;
  isIngestionPaused: boolean;
  onIngestionPauseChange: (paused: boolean) => void;
  contractId?: string;
}

export function ConsoleAndEventsDrawer({
  logs,
  baseLineNumber = 0,
  droppedMessages = 0,
  isIngestionPaused,
  onIngestionPauseChange,
  contractId,
}: ConsoleAndEventsDrawerProps) {
  const [activeTab, setActiveTab] = useState<"console" | "events" | "terminal">(
    "console",
  );

  const tabs = ["console", "terminal", "events"] as const;
  const tabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    let index = tabs.indexOf(activeTab);
    if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = tabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(tabs[index]);
    document.getElementById(`output-tab-${tabs[index]}`)?.focus();
  };
  return (
    <div
      id="workspace-console"
      role="region"
      aria-label="Console and event output"
      tabIndex={-1}
      className="flex flex-col rounded-xl border border-gray-800 bg-gray-950 overflow-hidden shadow-2xl"
    >
      {/* Navigation tabs */}
      <div
        role="tablist"
        aria-label="Output views"
        className="flex items-center gap-1 border-b border-gray-800 bg-gray-900 px-3 py-1.5 text-xs font-medium"
      >
        <button
          type="button"
          id="output-tab-console"
          role="tab"
          aria-selected={activeTab === "console"}
          aria-controls="output-tabpanel"
          tabIndex={activeTab === "console" ? 0 : -1}
          onKeyDown={tabKey}
          onClick={() => setActiveTab("console")}
          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 transition ${
            activeTab === "console"
              ? "bg-slate-800 text-cyan-400 font-semibold"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
          }`}
        >
          <Terminal size={14} />
          <span>Console Output</span>
        </button>

        <button
          type="button"
          id="output-tab-terminal"
          role="tab"
          aria-selected={activeTab === "terminal"}
          aria-controls="output-tabpanel"
          tabIndex={activeTab === "terminal" ? 0 : -1}
          onKeyDown={tabKey}
          onClick={() => setActiveTab("terminal")}
          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 transition ${
            activeTab === "terminal"
              ? "bg-slate-800 text-amber-400 font-semibold"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
          }`}
        >
          <SquareTerminal size={14} />
          <span>CLI Terminal</span>
        </button>

        <button
          type="button"
          id="output-tab-events"
          role="tab"
          aria-selected={activeTab === "events"}
          aria-controls="output-tabpanel"
          tabIndex={activeTab === "events" ? 0 : -1}
          onKeyDown={tabKey}
          onClick={() => setActiveTab("events")}
          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 transition ${
            activeTab === "events"
              ? "bg-slate-800 text-emerald-400 font-semibold"
              : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
          }`}
        >
          <Activity size={14} />
          <span>Event Streamer</span>
        </button>
      </div>

      {/* Content pane */}
      <div
        id="output-tabpanel"
        role="tabpanel"
        aria-labelledby={`output-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === "console" ? (
          <Console
            logs={logs}
            baseLineNumber={baseLineNumber}
            droppedMessages={droppedMessages}
            isIngestionPaused={isIngestionPaused}
            onIngestionPauseChange={onIngestionPauseChange}
          />
        ) : activeTab === "terminal" ? (
          <SorobanCliTerminal />
        ) : (
          <EventsPanel contractId={contractId} />
        )}
      </div>
    </div>
  );
}

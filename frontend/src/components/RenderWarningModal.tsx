"use client";

import React, { useState, useEffect, useRef } from "react";
import { useModalAccessibility } from "@/accessibility/useModalAccessibility";
import { Server, X, Info } from "lucide-react";

export default function RenderWarningModal() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const hasSeenWarning = sessionStorage.getItem("render_warning_seen");
    if (!hasSeenWarning) {
      setIsOpen(true);
    }
  }, []);

  const handleClose = () => {
    sessionStorage.setItem("render_warning_seen", "true");
    setIsOpen(false);
  };

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalAccessibility(dialogRef, isOpen, handleClose);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-300">
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={handleClose}
      />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="render-warning-title" aria-describedby="render-warning-description" className="relative w-full max-w-md overflow-hidden rounded-3xl bg-slate-900 border border-slate-700 shadow-[0_0_50px_rgba(0,0,0,0.5)] animate-in zoom-in-95 duration-300">
        {/* Glow effect */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-24 bg-cyan-500/20 blur-[60px] pointer-events-none" />

        <div className="p-6 sm:p-8">
          <div className="flex items-start justify-between mb-4">
            <div className="p-3 rounded-2xl bg-cyan-500/10 text-cyan-400">
              <Server size={28} />
            </div>
            <button
              aria-label="Close backend warming notice"
              onClick={handleClose}
              className="p-2 -mr-2 -mt-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          <h2 id="render-warning-title" className="text-xl font-bold text-white mb-2">
            Backend Warming Up
          </h2>
          <div id="render-warning-description" className="space-y-4 text-sm text-slate-300 leading-relaxed">
            <p>
              Welcome to the Soroban Playground! Please note that our backend
              infrastructure is currently hosted on{" "}
              <strong className="text-white">Render's free tier</strong>.
            </p>
            <div className="flex gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200">
              <Info className="shrink-0 mt-0.5 text-amber-400" size={16} />
              <p className="text-xs leading-relaxed">
                If the application hasn't been used in a while, the backend
                server may take{" "}
                <strong className="text-amber-400">50-60 seconds</strong> to
                spin up and respond to your first request (like compiling or
                deploying).
              </p>
            </div>
            <p>
              Thank you for your patience while the server wakes up! Future
              waves will upgrade to dedicated infrastructure.
            </p>
          </div>

          <button
            onClick={handleClose}
            className="mt-8 w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-bold tracking-wide hover:brightness-110 active:scale-[0.98] transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)]"
          >
            I Understand, Continue
          </button>
        </div>
      </div>
    </div>
  );
}

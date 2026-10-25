"use client";

import React from "react";
import XdrDecoderInspector from "@/components/XdrDecoderInspector";

export default function XdrDecoderPage() {
  return (
    <>
      <div className="p-6 max-w-7xl mx-auto h-[calc(100vh-2rem)]">
        <XdrDecoderInspector />
      </div>
    </>
  );
}

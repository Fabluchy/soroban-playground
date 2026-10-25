require("@testing-library/jest-dom");

// Polyfill the text encoding globals — JSDOM does not provide them, but the
// browser does and the Web Crypto API expects them.
const { TextEncoder, TextDecoder } = require("node:util");
if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === "undefined") {
  global.TextDecoder = TextDecoder;
}

// Mock fetch globally
global.fetch = jest.fn();

// Mock IntersectionObserver for JSDOM
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
};

// Mock ResizeObserver for JSDOM
global.ResizeObserver = class ResizeObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  unobserve() {}
};

// Mock crypto.subtle for JSDOM
const mockDigest = jest.fn();
Object.defineProperty(global, "crypto", {
  value: {
    subtle: {
      digest: mockDigest,
    },
  },
  writable: true,
  configurable: true,
});

// Mock File.prototype.arrayBuffer for JSDOM
if (typeof File !== "undefined" && !File.prototype.arrayBuffer) {
  File.prototype.arrayBuffer = async function () {
    return new ArrayBuffer(0);
  };
}
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = async function () {
    return new ArrayBuffer(0);
  };
}

// Mock Worker for JSDOM
if (typeof global.Worker === "undefined") {
  global.Worker = class MockWorker {
    constructor() {}
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  };
}

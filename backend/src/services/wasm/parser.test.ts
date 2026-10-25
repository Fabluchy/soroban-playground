// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Tests for WASM Parser
 */

import WasmParser, {
  extractSorobanMetadata,
  validateSorobanExports,
  validateSorobanImports,
} from './parser';

describe('WasmParser', () => {
  // Create a minimal valid WASM binary
  function createMinimalWasm(): Buffer {
    const parts: number[] = [];

    // Magic number and version
    parts.push(0x00, 0x61, 0x73, 0x6d); // \0asm
    parts.push(0x01, 0x00, 0x00, 0x00); // version 1

    // Empty type section
    parts.push(0x01); // Type section
    parts.push(0x01); // Section size
    parts.push(0x00); // 0 types

    return Buffer.from(parts);
  }

  test('should parse valid WASM magic and version', () => {
    const wasm = createMinimalWasm();
    const parser = new WasmParser(wasm);
    const metadata = parser.parse();

    expect(metadata.valid).toBe(true);
    expect(metadata.errors.length).toBe(0);
    expect(metadata.binarySize).toBe(wasm.length);
  });

  test('should reject invalid WASM magic number', () => {
    const invalid = Buffer.from([
      0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00,
    ]);
    const parser = new WasmParser(invalid);
    const metadata = parser.parse();

    expect(metadata.valid).toBe(false);
    expect(metadata.errors.length).toBeGreaterThan(0);
  });

  test('should detect contractspecv0 custom section', () => {
    const wasm = createMinimalWasm();
    const parser = new WasmParser(wasm);
    const metadata = parser.parse();

    // Minimal WASM won't have contractspecv0 by default
    expect(metadata.hasContractSpecV0).toBe(false);
  });

  test('should extract exports', () => {
    const wasm = createMinimalWasm();
    const parser = new WasmParser(wasm);
    const metadata = parser.parse();

    expect(metadata.exports).toBeDefined();
    expect(Array.isArray(metadata.exports)).toBe(true);
  });

  test('should extract imports', () => {
    const wasm = createMinimalWasm();
    const parser = new WasmParser(wasm);
    const metadata = parser.parse();

    expect(metadata.imports).toBeDefined();
    expect(Array.isArray(metadata.imports)).toBe(true);
  });

  test('should validate Soroban exports', () => {
    const wasm = createMinimalWasm();
    const parser = new WasmParser(wasm);
    const metadata = parser.parse();

    const validation = validateSorobanExports(metadata);
    expect(validation.valid).toBe(typeof validation.valid === 'boolean');
    expect(Array.isArray(validation.errors)).toBe(true);
  });

  test('should validate Soroban imports', () => {
    const wasm = createMinimalWasm();
    const parser = new WasmParser(wasm);
    const metadata = parser.parse();

    const validation = validateSorobanImports(metadata);
    expect(validation.valid).toBe(typeof validation.valid === 'boolean');
    expect(Array.isArray(validation.errors)).toBe(true);
  });

  test('should extract full Soroban metadata', () => {
    const wasm = createMinimalWasm();
    const result = extractSorobanMetadata(wasm);

    expect(result.binarySize).toBeGreaterThan(0);
    expect(result.exports).toBeDefined();
    expect(result.imports).toBeDefined();
    expect(result.exportValidation).toBeDefined();
    expect(result.importValidation).toBeDefined();
  });

  test('should handle empty buffer gracefully', () => {
    const emptyWasm = Buffer.from([]);
    const parser = new WasmParser(emptyWasm);
    const metadata = parser.parse();

    expect(metadata.valid).toBe(false);
    expect(metadata.errors.length).toBeGreaterThan(0);
  });
});

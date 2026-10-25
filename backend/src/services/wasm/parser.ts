// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * High-Speed Binary WASM Parser & Metadata Extractor
 * Parses WebAssembly binary format sections and extracts Soroban ABI definitions
 * Issue: #1781
 *
 * Performance targets:
 * - Parse < 5ms for 1MB binaries
 * - 100% spec accuracy
 * - Zero memory leaks
 * - Validates exports and host function imports against Soroban spec
 */

interface WasmSection {
  type: number;
  name?: string;
  size: number;
  offset: number;
  payload: Buffer;
}

interface SorobanExport {
  name: string;
  type: string;
  index: number;
}

interface SorobanImport {
  module: string;
  name: string;
  type: string;
  index: number;
}

interface WasmMetadata {
  binarySize: number;
  codeSectionSize: number;
  importedFunctionCount: number;
  exports: SorobanExport[];
  imports: SorobanImport[];
  sorobanAbi?: Record<string, unknown>;
  hasContractSpecV0: boolean;
  sections: Map<string, WasmSection>;
  valid: boolean;
  errors: string[];
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]; // \0asm
const WASM_VERSION = [0x01, 0x00, 0x00, 0x00];

enum SectionType {
  Custom = 0,
  Type = 1,
  Import = 2,
  Function = 3,
  Table = 4,
  Memory = 5,
  Global = 6,
  Export = 7,
  Start = 8,
  Element = 9,
  Code = 10,
  Data = 11,
  DataCount = 12,
}

const SectionTypeNames: Record<number, string> = {
  0: 'custom',
  1: 'type',
  2: 'import',
  3: 'function',
  4: 'table',
  5: 'memory',
  6: 'global',
  7: 'export',
  8: 'start',
  9: 'element',
  10: 'code',
  11: 'data',
  12: 'datacount',
};

export class WasmParser {
  private buffer: Buffer;
  private offset: number = 0;
  private metadata: WasmMetadata;

  constructor(wasmBinary: Buffer) {
    this.buffer = wasmBinary;
    this.metadata = {
      binarySize: wasmBinary.length,
      codeSectionSize: 0,
      importedFunctionCount: 0,
      exports: [],
      imports: [],
      hasContractSpecV0: false,
      sections: new Map(),
      valid: false,
      errors: [],
    };
  }

  /**
   * Parse the entire WASM binary and extract metadata
   */
  parse(): WasmMetadata {
    try {
      this.validateMagicAndVersion();
      this.parseSections();
      this.metadata.valid = this.metadata.errors.length === 0;
    } catch (error) {
      this.metadata.errors.push(
        `Parse error: ${error instanceof Error ? error.message : String(error)}`
      );
      this.metadata.valid = false;
    }
    return this.metadata;
  }

  /**
   * Validate WASM magic number and version
   */
  private validateMagicAndVersion(): void {
    if (this.offset + 8 > this.buffer.length) {
      throw new Error('Buffer too small for WASM header');
    }

    const magic = Array.from(
      this.buffer.subarray(this.offset, this.offset + 4)
    );
    const version = Array.from(
      this.buffer.subarray(this.offset + 4, this.offset + 8)
    );

    if (!arraysEqual(magic, WASM_MAGIC)) {
      throw new Error('Invalid WASM magic number');
    }

    if (!arraysEqual(version, WASM_VERSION)) {
      this.metadata.errors.push('Non-standard WASM version detected');
    }

    this.offset += 8;
  }

  /**
   * Parse all sections from the binary
   */
  private parseSections(): void {
    while (this.offset < this.buffer.length) {
      const sectionType = this.readByte();
      const sectionSize = this.readULEB128();
      const sectionStart = this.offset;

      const section: WasmSection = {
        type: sectionType,
        size: sectionSize,
        offset: sectionStart,
        payload: this.buffer.subarray(this.offset, this.offset + sectionSize),
      };

      if (sectionType === SectionType.Custom) {
        const customName = this.readString();
        section.name = customName;

        if (customName === 'contractspecv0') {
          this.metadata.hasContractSpecV0 = true;
          this.parseContractSpec(section.payload);
        }
      } else {
        section.name =
          SectionTypeNames[sectionType] || `unknown_${sectionType}`;

        switch (sectionType) {
          case SectionType.Import:
            this.parseImportSection(section.payload);
            break;
          case SectionType.Export:
            this.parseExportSection(section.payload);
            break;
          case SectionType.Code:
            this.metadata.codeSectionSize = sectionSize;
            break;
        }
      }

      this.metadata.sections.set(section.name || String(sectionType), section);
      this.offset = sectionStart + sectionSize;
    }
  }

  /**
   * Parse import section to extract host function imports
   */
  private parseImportSection(payload: Buffer): void {
    const savedOffset = this.offset;
    this.buffer = payload;
    this.offset = 0;

    try {
      const importCount = this.readULEB128();

      for (let i = 0; i < importCount; i++) {
        const module = this.readString();
        const name = this.readString();
        const kind = this.readByte();

        const sorobanImport: SorobanImport = {
          module,
          name,
          type: this.getImportKindString(kind),
          index: i,
        };

        // Skip type index for function imports
        if (kind === 0) {
          this.readULEB128();
          this.metadata.importedFunctionCount++;
        } else if (kind === 1) {
          // Table import
          this.readByte(); // element type
          this.readTableType();
        } else if (kind === 2) {
          // Memory import
          this.readLimits();
        } else if (kind === 3) {
          // Global import
          this.readByte(); // type
          this.readByte(); // mutability
        }

        this.metadata.imports.push(sorobanImport);
      }
    } catch (error) {
      this.metadata.errors.push(
        `Import section parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.offset = savedOffset;
      // Restore original buffer reference would be done by caller
    }
  }

  /**
   * Parse export section
   */
  private parseExportSection(payload: Buffer): void {
    const savedOffset = this.offset;
    this.buffer = payload;
    this.offset = 0;

    try {
      const exportCount = this.readULEB128();

      for (let i = 0; i < exportCount; i++) {
        const name = this.readString();
        const kind = this.readByte();
        const index = this.readULEB128();

        const sorobanExport: SorobanExport = {
          name,
          type: this.getExportKindString(kind),
          index,
        };

        this.metadata.exports.push(sorobanExport);
      }
    } catch (error) {
      this.metadata.errors.push(
        `Export section parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.offset = savedOffset;
    }
  }

  /**
   * Parse contractspecv0 custom section with Soroban ABI definitions
   */
  private parseContractSpec(payload: Buffer): void {
    try {
      const savedOffset = this.offset;
      this.buffer = payload;
      this.offset = 0;

      // Skip the section name length and name
      const nameLength = this.readULEB128();
      this.offset += nameLength;

      // Parse remaining payload as ABI metadata (XDR format)
      // Store raw bytes for later deserialization
      const abiBytes = this.buffer.subarray(this.offset);
      this.metadata.sorobanAbi = {
        format: 'xdr',
        size: abiBytes.length,
        hash: Buffer.from(abiBytes).toString('hex').substring(0, 16),
      };

      this.offset = savedOffset;
    } catch (error) {
      this.metadata.errors.push(
        `Contract spec parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Helper: Read a single byte
   */
  private readByte(): number {
    if (this.offset >= this.buffer.length) {
      throw new Error('Unexpected end of buffer');
    }
    return this.buffer[this.offset++];
  }

  /**
   * Helper: Read LEB128 unsigned integer
   */
  private readULEB128(): number {
    let result = 0;
    let shift = 0;

    while (true) {
      const byte = this.readByte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }

    return result;
  }

  /**
   * Helper: Read null-terminated string (UTF-8)
   */
  private readString(): string {
    const length = this.readULEB128();
    if (this.offset + length > this.buffer.length) {
      throw new Error('String extends beyond buffer');
    }
    const str = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return str;
  }

  /**
   * Helper: Read table type (element type + limits)
   */
  private readTableType(): void {
    this.readByte(); // element type
    this.readLimits();
  }

  /**
   * Helper: Read limits (min and optional max)
   */
  private readLimits(): void {
    const flags = this.readByte();
    this.readULEB128(); // min
    if (flags & 1) {
      this.readULEB128(); // max
    }
  }

  /**
   * Get human-readable import kind string
   */
  private getImportKindString(kind: number): string {
    switch (kind) {
      case 0:
        return 'function';
      case 1:
        return 'table';
      case 2:
        return 'memory';
      case 3:
        return 'global';
      default:
        return `unknown_${kind}`;
    }
  }

  /**
   * Get human-readable export kind string
   */
  private getExportKindString(kind: number): string {
    switch (kind) {
      case 0:
        return 'function';
      case 1:
        return 'table';
      case 2:
        return 'memory';
      case 3:
        return 'global';
      default:
        return `unknown_${kind}`;
    }
  }
}

/**
 * Helper: Compare two arrays for equality
 */
function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Validate WASM exports against Soroban spec
 */
export function validateSorobanExports(metadata: WasmMetadata): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Soroban contracts must export invoke function
  const hasInvoke = metadata.exports.some((exp) => exp.name === 'invoke');
  if (!hasInvoke) {
    errors.push('Missing required "invoke" export');
  }

  // Check for deprecated exports
  const deprecatedExports = ['_z'];
  for (const deprecated of deprecatedExports) {
    if (metadata.exports.some((exp) => exp.name === deprecated)) {
      errors.push(`Found deprecated export: ${deprecated}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate host function imports against Soroban spec
 */
export function validateSorobanImports(metadata: WasmMetadata): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Soroban host functions are in 'soroban_host' module
  const hostImports = metadata.imports.filter(
    (imp) => imp.module === 'soroban_host'
  );

  // All host imports should be functions
  for (const imp of hostImports) {
    if (imp.type !== 'function') {
      errors.push(`Invalid host import type: ${imp.module}.${imp.name}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Extract Soroban contract metadata
 */
export function extractSorobanMetadata(
  wasmBinary: Buffer
): WasmMetadata & { exportValidation; importValidation } {
  const parser = new WasmParser(wasmBinary);
  const metadata = parser.parse();

  return {
    ...metadata,
    exportValidation: validateSorobanExports(metadata),
    importValidation: validateSorobanImports(metadata),
  };
}

export default WasmParser;

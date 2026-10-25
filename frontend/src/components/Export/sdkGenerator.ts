import type { ContractSpec, SdkBundle, SorobanType, SpecField } from "./types";

function identifier(value: string): string {
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    ["constructor", "__proto__", "prototype"].includes(value)
  ) {
    throw new Error(`Invalid contract identifier: ${value}`);
  }
  return value;
}
/** Map the decoded contract spec to lossless TypeScript value types. */
export function sorbanTypeToTs(
  type: SorobanType,
  definitions = new Set<string>(),
): string {
  if (/^[ui](32|64|128|256)$/.test(type.kind)) return "bigint";
  switch (type.kind) {
    case "bool":
      return "boolean";
    case "string":
    case "symbol":
    case "address":
      return "string";
    case "bytes":
    case "bytesN":
      return "Uint8Array";
    case "void":
      return "void";
    case "vec":
      return `(${sorbanTypeToTs(type.elements?.[0] ?? { kind: "unknown" }, definitions)})[]`.replace(
        /^\((\w+)\)\[\]$/,
        "$1[]",
      );
    case "option":
      return `${sorbanTypeToTs(type.child ?? { kind: "unknown" }, definitions)} | null`;
    case "tuple":
      return `[${(type.elements ?? []).map((t) => sorbanTypeToTs(t, definitions)).join(", ")}]`;
    case "def":
      return type.defName && definitions.has(type.defName)
        ? identifier(type.defName)
        : "unknown";
    default:
      return "unknown";
  }
}

export function generateSdkBundle(spec: ContractSpec): SdkBundle {
  if (!/^[a-z][a-z0-9.-]*$/i.test(spec.name))
    throw new Error("A valid contract name is required");
  const className =
    spec.name
      .split(/[.-]/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("") + "Client";
  identifier(className);
  const defs = new Set([
    ...(spec.structs ?? []).map((d) => identifier(d.name)),
    ...(spec.enums ?? []).map((d) => identifier(d.name)),
  ]);
  const fields = (values: SpecField[]) =>
    values
      .map(
        (field) =>
          `  ${identifier(field.name)}: ${sorbanTypeToTs(field.type, defs)};`,
      )
      .join("\n");
  const types = [
    ...(spec.structs ?? []).map(
      (d) => `export interface ${identifier(d.name)} {\n${fields(d.fields)}\n}`,
    ),
    ...(spec.enums ?? []).map(
      (d) =>
        `export enum ${identifier(d.name)} {\n${d.cases
          .map((c) => {
            if (!Number.isSafeInteger(c.value))
              throw new Error("Enum values must be safe integers");
            return `  ${identifier(c.name)} = ${c.value},`;
          })
          .join("\n")}\n}`,
    ),
    ...(spec.events ?? []).map(
      (d) =>
        `export interface ${identifier(d.name)}Event {\n${fields(d.fields)}\n}`,
    ),
  ].join("\n\n");
  const methods = spec.functions
    .map((fn) => {
      identifier(fn.name);
      const output =
        fn.outputs.length === 0
          ? "void"
          : fn.outputs.length === 1
            ? sorbanTypeToTs(fn.outputs[0], defs)
            : `[${fn.outputs.map((t) => sorbanTypeToTs(t, defs)).join(", ")}]`;
      return `  async ${fn.name}(args: {\n${fields(fn.inputs)}\n}): Promise<${output}> {\n    return this.options.transport.invoke<${output}>(${JSON.stringify(fn.name)}, args, { contractId: this.options.contractId, networkPassphrase: this.options.networkPassphrase ?? TESTNET_PASSPHRASE, readOnly: ${Boolean(fn.read_only)} });\n  }`;
    })
    .join("\n\n");
  const client = `import type * as Types from "./types.js";\nimport type { ${[...defs].join(", ")} } from "./types.js";\nexport const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";\n/** Supply an adapter that simulates, authorizes, signs and submits through Stellar SDK. */\nexport interface ContractTransport {\n  invoke<T>(method: string, args: Record<string, unknown>, options: { contractId: string; networkPassphrase: string; readOnly: boolean }): Promise<T>;\n}\nexport interface ClientOptions { contractId: string; transport: ContractTransport; networkPassphrase?: string }\nexport class ${className} {\n  constructor(private readonly options: ClientOptions) {}\n${methods}\n}\n`;
  const errors = Object.fromEntries(
    (spec.errors ?? []).map((error) => {
      if (!Number.isSafeInteger(error.code))
        throw new Error("Error codes must be safe integers");
      return [error.code, error.doc || error.name];
    }),
  );
  const file = (name: string, content: string) => ({ name, content });
  return {
    name: spec.name,
    files: [
      file("src/types.ts", types + "\n"),
      file(
        "src/client.ts",
        client
          .replace('import type * as Types from "./types.js";\n', "")
          .replace('import type {  } from "./types.js";\n', ""),
      ),
      file(
        "src/errors.ts",
        `const messages: Record<number,string> = ${JSON.stringify(errors, null, 2)};\nexport function decodeContractError(code: number): string { return messages[code] ?? \`Unknown contract error: \${code}\`; }\n`,
      ),
      file(
        "src/index.ts",
        'export * from "./types.js";\nexport * from "./client.js";\nexport * from "./errors.js";\n',
      ),
      file(
        "package.json",
        JSON.stringify(
          {
            name: spec.name.toLowerCase() + "-sdk",
            version: spec.version ?? "0.1.0",
            type: "module",
            main: "dist/index.js",
            types: "dist/index.d.ts",
            scripts: { build: "tsc" },
            dependencies: { "@stellar/stellar-sdk": "^12.3.0" },
            devDependencies: { typescript: "^5.9.0" },
          },
          null,
          2,
        ) + "\n",
      ),
      file(
        "tsconfig.json",
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ES2022",
              moduleResolution: "bundler",
              declaration: true,
              strict: true,
              outDir: "dist",
            },
            include: ["src"],
          },
          null,
          2,
        ) + "\n",
      ),
      file(
        "README.md",
        `# ${spec.name} SDK\n\nInstall and build with \`npm install\` and \`npm run build\`.\n\nDefault network: Test SDF Network ; September 2015.\n\nConstruct \`${className}\` with a contract ID and a \`ContractTransport\` adapter implemented using Stellar SDK. The adapter must encode arguments, simulate calls, obtain explicit wallet authorization for writes, and submit signed transactions; this package does not store keys or automatically sign. Override the network passphrase explicitly for another network.\n`,
      ),
    ],
  };
}

/** Store-mode ZIP archive: valid UTF-8 paths, checksums and a central directory. */
export function buildZipFromBundle(bundle: SdkBundle): Blob {
  if (bundle.files.length > 65535) throw new Error("Too many SDK files");
  const encoder = new TextEncoder();
  const local: Uint8Array<ArrayBuffer>[] = [],
    central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const file of bundle.files) {
    if (
      file.name.startsWith("/") ||
      file.name.includes("\\") ||
      file.name.split("/").includes("..")
    )
      throw new Error("Unsafe archive path");
    const name = encoder.encode(file.name),
      body = encoder.encode(file.content);
    if (name.length > 65535) throw new Error("Archive path is too long");
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length),
      view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 0x21, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, body.length, true);
    view.setUint32(22, body.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    const entry = new Uint8Array(46 + name.length),
      directory = new DataView(entry.buffer);
    directory.setUint32(0, 0x02014b50, true);
    directory.setUint16(4, 20, true);
    directory.setUint16(6, 20, true);
    directory.setUint16(8, 0x800, true);
    directory.setUint16(14, 0x21, true);
    directory.setUint32(16, crc, true);
    directory.setUint32(20, body.length, true);
    directory.setUint32(24, body.length, true);
    directory.setUint16(28, name.length, true);
    directory.setUint32(42, offset, true);
    entry.set(name, 46);
    local.push(header, body);
    central.push(entry);
    offset += header.length + body.length;
  }
  const end = new Uint8Array(22),
    view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, bundle.files.length, true);
  view.setUint16(10, bundle.files.length, true);
  view.setUint32(
    12,
    central.reduce((n, entry) => n + entry.length, 0),
    true,
  );
  view.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: "application/zip" });
}

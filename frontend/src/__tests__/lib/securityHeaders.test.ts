import fs from "fs";
import path from "path";
import {
  CSP_HEADER,
  buildContentSecurityPolicy,
  extractNonce,
  generateNonce,
} from "@/lib/securityHeaders";

/**
 * Security-header regression tests for #1540.
 *
 * These assert on the header values the app *actually builds*, not on source
 * text. A policy that silently regains `'unsafe-inline'` in `script-src` would
 * re-open the XSS hole that `lib/sanitize.ts` exists to close, and no unit test
 * on the sanitizer would catch it - so the header itself needs its own guard.
 *
 * The CSP is asserted against `buildContentSecurityPolicy` (the function
 * `middleware.ts` calls) rather than `next.config.ts`, because the policy has to
 * carry a per-request nonce and `headers()` is evaluated once at build time.
 * The remaining static headers are still read out of the real config, which is
 * transpiled and evaluated here because importing it would pull in webpack hooks
 * that are meaningless under jest.
 */

const configPath = path.resolve(__dirname, "../../../next.config.ts");

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/** Evaluate `headers()` from the real config and return the rules it produces. */
async function loadHeaderRules(): Promise<HeaderRule[]> {
  const babel = require("@babel/core");
  const source = fs.readFileSync(configPath, "utf8");

  const { code } = babel.transformSync(source, {
    filename: configPath,
    presets: [
      ["@babel/preset-typescript", { isTSX: false, allExtensions: true }],
      ["@babel/preset-react", { runtime: "automatic" }],
    ],
    plugins: ["@babel/plugin-transform-modules-commonjs"],
  });

  const sandboxModule = { exports: { default: null as unknown } };
  const factory = new Function("module", "exports", "require", "process", "Buffer", code!);
  factory(sandboxModule, sandboxModule.exports, require, process, Buffer);

  const config = (
    sandboxModule.exports as {
      default: { headers: () => Promise<HeaderRule[]> };
    }
  ).default;
  return config.headers();
}

function cspDirectives(csp: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};

  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      continue;
    }
    directives[tokens[0]] = tokens.slice(1);
  }

  return directives;
}

let rules: HeaderRule[];
let directives: Record<string, string[]>;

beforeAll(async () => {
  rules = await loadHeaderRules();
  // A representative fixed nonce keeps the assertions deterministic; the
  // randomness of the real value is covered by the `generateNonce` block below.
  directives = cspDirectives(buildContentSecurityPolicy("dGVzdC1ub25jZQ=="));
});

describe("security headers - route scope", () => {
  it("applies the headers to every route", () => {
    expect(rules[0].source).toBe("/:path*");
  });

  it("sends exactly one header set", () => {
    expect(rules).toHaveLength(1);
  });

  it("leaves the CSP to middleware, which can mint a per-request nonce", () => {
    // If the CSP came back here it would be frozen at build time, and a build
    // time nonce is a constant an attacker can simply read off the page.
    const csp = rules[0].headers.find(
      (entry) => entry.key.toLowerCase() === "content-security-policy",
    );

    expect(csp).toBeUndefined();
  });
});

describe("security headers - transport and framing", () => {
  const value = (key: string): string => rules[0].headers.find((entry) => entry.key === key)?.value;

  it("sets Strict-Transport-Security with preload", () => {
    expect(value("Strict-Transport-Security")).toContain("max-age=63072000");
    expect(value("Strict-Transport-Security")).toContain("includeSubDomains");
    expect(value("Strict-Transport-Security")).toContain("preload");
  });

  it("denies framing", () => {
    expect(value("X-Frame-Options")).toBe("DENY");
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("sets nosniff and a strict referrer policy", () => {
    expect(value("X-Content-Type-Options")).toBe("nosniff");
    expect(value("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("locks down the Permissions-Policy features the app never uses", () => {
    const permissions = value("Permissions-Policy");

    expect(permissions).toContain("camera=()");
    expect(permissions).toContain("microphone=()");
    expect(permissions).toContain("geolocation=()");
  });

  it("sets the cross-origin isolation headers Monaco's workers need", () => {
    expect(value("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(value("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("sets the legacy headers modern scanners still check", () => {
    expect(value("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(value("X-Permitted-Cross-Domain-Policies")).toBe("none");
  });

  it("pins X-XSS-Protection to 0 rather than the vulnerable enabled mode", () => {
    // The old `1; mode=block` auditor can itself introduce a vulnerability, so
    // modern practice is to disable it and rely on the CSP.
    expect(value("X-XSS-Protection")).toBe("0");
  });
});

describe("CSP - script execution policy (#1540)", () => {
  it("does not allow unsafe-inline in script-src", () => {
    // This is the assertion that matters most: 'unsafe-inline' would let an
    // injected <script> run even if the markup was sanitized.
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("scopes inline scripts to a nonce with strict-dynamic", () => {
    const scriptSrc = directives["script-src"];
    const nonce = scriptSrc.filter((value) => value.startsWith("'nonce-"));

    expect(nonce).toHaveLength(1);
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("keeps only the WebAssembly and language-server escape hatches", () => {
    const scriptSrc = directives["script-src"];

    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    // The pinned monaco-languageclient builds workers from data URLs.
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it("does not allow a bare host wildcard to serve executable script", () => {
    for (const value of directives["script-src"]) {
      expect(value).not.toBe("*");
      expect(value).not.toBe("https:");
      expect(value).not.toBe("data:");
    }
  });

  it("forbids object, base and form injection vectors", () => {
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["form-action"]).toEqual(["'self'"]);
  });
});

describe("CSP - nonce lifecycle", () => {
  it("scopes inline scripts to the exact nonce that was requested", () => {
    const scoped = cspDirectives(buildContentSecurityPolicy("YWJjZGVm"));

    expect(scoped["script-src"]).toContain("'nonce-YWJjZGVm'");
  });

  it("produces a different policy for every request", () => {
    // Two nonces must never collide, or a script authorised by one response
    // would also be authorised by the other.
    const first = buildContentSecurityPolicy(generateNonce());
    const second = buildContentSecurityPolicy(generateNonce());

    expect(first).not.toBe(second);
  });

  it("generates a base64 nonce of usable length", () => {
    const nonce = generateNonce();

    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
  });

  it("falls back to unsafe-inline only when no nonce is available", () => {
    // Static export has no middleware, so there is no nonce to hand out. This
    // is the weaker policy and it is deliberate: a placeholder nonce would
    // block every script instead.
    const fallback = cspDirectives(buildContentSecurityPolicy());

    expect(fallback["script-src"]).toContain("'unsafe-inline'");
    expect(fallback["script-src"].some((v) => v.startsWith("'nonce-"))).toBe(false);
  });

  it("never emits the literal string undefined as a nonce", () => {
    const policy = buildContentSecurityPolicy(extractNonce(null) ?? undefined);

    expect(policy).not.toContain("undefined");
  });
});

describe("extractNonce", () => {
  it("recovers the nonce from a built policy", () => {
    const nonce = generateNonce();

    expect(extractNonce(buildContentSecurityPolicy(nonce))).toBe(nonce);
  });

  it("returns null when the policy carries no nonce", () => {
    expect(extractNonce(buildContentSecurityPolicy())).toBeNull();
  });

  it("returns null for empty, null and undefined input", () => {
    expect(extractNonce(null)).toBeNull();
    expect(extractNonce(undefined)).toBeNull();
    expect(extractNonce("")).toBeNull();
  });

  it("stops the match at the closing quote", () => {
    // A greedy match would swallow following directives and hand the layout a
    // nonce that can never match, blocking the theme bootstrap.
    expect(extractNonce("script-src 'nonce-abc' 'strict-dynamic'")).toBe("abc");
  });

  it("uses the Content-Security-Policy header name", () => {
    expect(CSP_HEADER).toBe("Content-Security-Policy");
  });
});

describe("CSP - resource loading", () => {
  it("falls back to same-origin via default-src", () => {
    expect(directives["default-src"]).toEqual(["'self'"]);
  });

  it("permits inline styles for Tailwind and Monaco", () => {
    expect(directives["style-src"]).toContain("'unsafe-inline'");
    expect(directives["style-src-attr"]).toContain("'unsafe-inline'");
  });

  it("allows images from the app, data URIs and blob URLs", () => {
    expect(directives["img-src"]).toEqual(["'self'", "data:", "blob:", "https:"]);
  });

  it("declares worker-src for the language-server and stream workers", () => {
    expect(directives["worker-src"]).toEqual(["'self'", "blob:"]);
  });

  it("restricts framing of child documents to the app itself", () => {
    expect(directives["frame-src"]).toEqual(["'self'"]);
  });

  it("allowlists only known Stellar and app origins for connect-src", () => {
    const connect = directives["connect-src"];

    expect(connect).toContain("'self'");
    expect(connect).toContain("https://soroban-testnet.stellar.org");
    expect(connect).toContain("https://horizon-testnet.stellar.org");
    expect(connect).toContain("wss:");
  });

  it("does not force https upgrades, which would break local http development", () => {
    // `upgrade-insecure-requests` rewrites http://localhost requests in the
    // browser, so it is deliberately absent.
    expect(directives["upgrade-insecure-requests"]).toBeUndefined();
  });
});

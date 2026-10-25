/**
 * Unit tests for the encrypted GitHub token storage (issue #1727 / FE-27).
 *
 * The global `crypto` object is replaced with the Node.js WebCrypto
 * implementation so the real AES-GCM / PBKDF2 code path is exercised.
 */

import { webcrypto } from "node:crypto";

import {
  clearToken,
  getTokenInfo,
  isWebCryptoAvailable,
  loadToken,
  resetTokenStorage,
  saveToken,
} from "@/lib/git/tokenStorage";
import { safeStorage } from "@/lib/offline/storage";

const ORIGINAL_CRYPTO = globalThis.crypto;

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: ORIGINAL_CRYPTO,
    writable: true,
    configurable: true,
  });
});

beforeEach(() => {
  resetTokenStorage();
});

describe("git/tokenStorage", () => {
  it("detects the Web Crypto availability", () => {
    expect(isWebCryptoAvailable()).toBe(true);
  });

  it("stores a token in an encrypted form", async () => {
    await saveToken("github_pat_secret");

    const raw = safeStorage.getItem("soroban-playground.git.pat");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("github_pat_secret");
  });

  it("restores the stored token", async () => {
    await saveToken("github_pat_secret");
    await expect(loadToken()).resolves.toBe("github_pat_secret");
  });

  it("returns null when no token is stored", async () => {
    await expect(loadToken()).resolves.toBeNull();
  });

  it("rejects an empty token", async () => {
    await expect(saveToken("   ")).rejects.toThrow("must not be empty");
  });

  it("reports the token metadata", async () => {
    expect(getTokenInfo()).toEqual({ present: false, updatedAt: null });

    await saveToken("github_pat_secret");
    const info = getTokenInfo();
    expect(info.present).toBe(true);
    expect(typeof info.updatedAt).toBe("number");
  });

  it("forgets the token", async () => {
    await saveToken("github_pat_secret");
    clearToken();
    expect(getTokenInfo().present).toBe(false);
    await expect(loadToken()).resolves.toBeNull();
  });

  it("cannot decrypt when the device secret was replaced", async () => {
    await saveToken("github_pat_secret");
    safeStorage.removeItem("soroban-playground.git.device-secret");
    await expect(loadToken()).resolves.toBeNull();
  });

  it("produces a different ciphertext for every token", async () => {
    await saveToken("token-one");
    const first = safeStorage.getItem("soroban-playground.git.pat");
    await saveToken("token-two");
    const second = safeStorage.getItem("soroban-playground.git.pat");
    expect(first).not.toBe(second);
    await expect(loadToken()).resolves.toBe("token-two");
  });
});

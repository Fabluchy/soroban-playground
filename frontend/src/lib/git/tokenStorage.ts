// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Encrypted storage for the GitHub Personal Access Token (issue #1727).
 *
 * The token never touches `localStorage` in plain text. A per-device secret is
 * generated once, persisted locally and used to derive an AES-GCM key through
 * PBKDF2. Only the resulting ciphertext is stored.
 *
 * This protects the token against casual inspection of the browser storage
 * and against other scripts running on the same origin; it is *not* a defence
 * against a compromised browser profile.
 */

import { readJson, safeStorage, writeJson } from "@/lib/offline/storage";

/** Key under which the per-device secret is persisted. */
const DEVICE_SECRET_KEY = "soroban-playground.git.device-secret";

/** Key under which the encrypted token payload is persisted. */
const TOKEN_KEY = "soroban-playground.git.pat";

/** Number of PBKDF2 iterations used to derive the encryption key. */
const PBKDF2_ITERATIONS = 100_000;

/** Salt length in bytes. */
const SALT_LENGTH = 16;

/** IV length in bytes (AES-GCM recommendation). */
const IV_LENGTH = 12;

/** The encrypted payload as it is persisted. */
interface EncryptedTokenPayload {
  /** Base64 encoded salt. */
  salt: string;
  /** Base64 encoded initialisation vector. */
  iv: string;
  /** Base64 encoded ciphertext. */
  ciphertext: string;
  /** Epoch milliseconds when the payload was written. */
  updatedAt: number;
}

/** Metadata about the stored token, without exposing the secret itself. */
export interface StoredTokenInfo {
  /** `true` when a token is stored. */
  present: boolean;
  /** Epoch milliseconds of the last write. */
  updatedAt: number | null;
}

/** `true` when the environment provides a usable Web Crypto implementation. */
export function isWebCryptoAvailable(): boolean {
  const subtle = globalThis.crypto?.subtle;
  return Boolean(subtle && typeof subtle.importKey === "function");
}

function getCrypto(): Crypto {
  const webCrypto = globalThis.crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== "function") {
    throw new Error(
      "Web Crypto is unavailable — the GitHub token cannot be encrypted in this environment.",
    );
  }
  return webCrypto;
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.importKey !== "function") {
    throw new Error(
      "Web Crypto is unavailable — the GitHub token cannot be encrypted in this environment.",
    );
  }
  return subtle;
}

/** Encode bytes as base64. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(binary, "binary").toString("base64");
}

/** Decode a base64 string into bytes. */
function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** Read (or create) the per-device secret. */
function getDeviceSecret(): Uint8Array {
  const stored = readJson<{ secret?: string } | null>(DEVICE_SECRET_KEY, null);
  if (stored?.secret) {
    try {
      return fromBase64(stored.secret);
    } catch {
      // Corrupt secret — fall through and regenerate it.
    }
  }

  const secret = new Uint8Array(32);
  getCrypto().getRandomValues(secret);
  writeJson(DEVICE_SECRET_KEY, { secret: toBase64(secret) });
  return secret;
}

/** Derive the AES-GCM key for a given salt. */
async function deriveKey(
  secret: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const material = await subtle.importKey(
    "raw",
    secret as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a GitHub token and persist it.
 *
 * @throws when Web Crypto is unavailable.
 */
export async function saveToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error("The GitHub token must not be empty.");
  }

  const subtle = getSubtle();
  const secret = getDeviceSecret();
  const salt = new Uint8Array(SALT_LENGTH);
  getCrypto().getRandomValues(salt);
  const iv = new Uint8Array(IV_LENGTH);
  getCrypto().getRandomValues(iv);

  const key = await deriveKey(secret, salt);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(trimmed) as unknown as BufferSource,
  );

  const payload: EncryptedTokenPayload = {
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    updatedAt: Date.now(),
  };

  writeJson(TOKEN_KEY, payload);
}

/**
 * Decrypt and return the stored GitHub token.
 *
 * Returns `null` when no token is stored or when the payload cannot be
 * decrypted (e.g. the device secret was regenerated).
 */
export async function loadToken(): Promise<string | null> {
  const payload = readJson<EncryptedTokenPayload | null>(TOKEN_KEY, null);
  if (!payload?.ciphertext) return null;

  try {
    const secret = getDeviceSecret();
    const salt = fromBase64(payload.salt);
    const iv = fromBase64(payload.iv);
    const key = await deriveKey(secret, salt);
    const plaintext = await getSubtle().decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      fromBase64(payload.ciphertext) as unknown as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong key or corrupted payload — treat it as "no token".
    return null;
  }
}

/** Forget the stored token. */
export function clearToken(): void {
  safeStorage.removeItem(TOKEN_KEY);
}

/** Metadata about the stored token. */
export function getTokenInfo(): StoredTokenInfo {
  const payload = readJson<EncryptedTokenPayload | null>(TOKEN_KEY, null);
  if (!payload?.ciphertext) return { present: false, updatedAt: null };
  return { present: true, updatedAt: payload.updatedAt ?? null };
}

/** Test seam: remove every trace of the stored token. */
export function resetTokenStorage(): void {
  clearToken();
  safeStorage.removeItem(DEVICE_SECRET_KEY);
}

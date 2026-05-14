// Stable per-install device id, generated once and persisted in the KV store.
// UUID v4 (16 bytes of randomness). Survives across SDK reconnects; lost only
// if the underlying storage is wiped.

import type { KVStore } from "./store/interface.js";

const DEVICE_ID_KEY = "deviceId";

/** Generate a UUID v4. Uses `crypto.randomUUID` when available
 *  (browsers, Node 18+, Hermes V1), falls back to `crypto.getRandomValues`
 *  otherwise. Exported so internal call sites don't reach for
 *  `globalThis.crypto.randomUUID` directly. */
export function generateUUID(): string {
  // Web Crypto + modern Node both expose crypto.randomUUID().
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Defensive fallback: build a UUID v4 from random bytes.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function loadOrCreateDeviceId(store: KVStore): Promise<string> {
  const existing = await store.getString(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = generateUUID();
  await store.setString(DEVICE_ID_KEY, id);
  return id;
}

/** Test-only: forget the persisted device id. Real users never call this. */
export async function resetDeviceId(store: KVStore): Promise<void> {
  await store.delete(DEVICE_ID_KEY);
}

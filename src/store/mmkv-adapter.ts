// KVStore adapter for `react-native-mmkv` (v3+). Use from React Native
// hosts; the host constructs the `MMKV` instance (so they can configure
// `id`, `encryptionKey`, `path`, etc. to match their app), then hands it
// to this adapter:
//
//   import { MMKV } from "react-native-mmkv";
//   import { DTelecomSecureChat, MMKVKVStore } from "@dtelecom/secure-chat-client";
//
//   const mmkv = new MMKV({ id: "secure-chat" });
//   const chat = await DTelecomSecureChat.connect({
//     ...,
//     store: new MMKVKVStore(mmkv),
//   });
//
// We type the MMKV instance structurally (the subset we actually use)
// rather than importing `react-native-mmkv` directly. That keeps the SDK
// from taking a hard dep on a React Native package — important for the
// web/Node builds which never see MMKV. TypeScript callers still get
// full inference because the real MMKV class satisfies this interface.

import type { KVStore } from "./interface.js";

/**
 * Structural subset of `react-native-mmkv@^3`'s `MMKV` class. The host's
 * `new MMKV(...)` instance assigns to this type without casts.
 */
export interface MMKVLike {
  /** Set a string or binary value. MMKV v3 accepts string | boolean | number | Uint8Array | ArrayBuffer. */
  set(key: string, value: string | Uint8Array): void;
  getString(key: string): string | undefined;
  /** Returns a copy of the stored binary value, or undefined. */
  getBuffer(key: string): Uint8Array | undefined;
  delete(key: string): void;
  getAllKeys(): string[];
}

/**
 * `KVStore` backed by an MMKV instance. MMKV is synchronous + in-process
 * (mmap-backed), so the async-method shape just wraps the sync calls;
 * there's no real I/O latency to absorb.
 *
 * Storage layout: keys are stored verbatim; binary values use MMKV's
 * native buffer API (no base64 round-trip). One MMKV instance per signed-
 * in user is recommended so signing out / switching users wipes the
 * SDK's local state via `mmkv.clearAll()` on the host's side.
 */
export class MMKVKVStore implements KVStore {
  constructor(private readonly mmkv: MMKVLike) {}

  async getString(key: string): Promise<string | null> {
    const v = this.mmkv.getString(key);
    return v === undefined ? null : v;
  }

  async setString(key: string, value: string): Promise<void> {
    this.mmkv.set(key, value);
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const v = this.mmkv.getBuffer(key);
    return v === undefined ? null : v;
  }

  async setBytes(key: string, value: Uint8Array): Promise<void> {
    this.mmkv.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.mmkv.delete(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const all = this.mmkv.getAllKeys();
    if (prefix === "") return all;
    return all.filter((k) => k.startsWith(prefix));
  }
}

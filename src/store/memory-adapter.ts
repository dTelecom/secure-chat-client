// In-memory KVStore for unit tests and Node-side smoke tests where we don't
// want an IndexedDB dependency. Same semantics as WebKVStore.

import type { KVStore } from "./interface.js";

interface StoredValue {
  type: "string" | "bytes";
  value: string | Uint8Array;
}

export class MemoryKVStore implements KVStore {
  private map = new Map<string, StoredValue>();

  async getString(key: string): Promise<string | null> {
    const v = this.map.get(key);
    return v?.type === "string" ? (v.value as string) : null;
  }
  async setString(key: string, value: string): Promise<void> {
    this.map.set(key, { type: "string", value });
  }
  async getBytes(key: string): Promise<Uint8Array | null> {
    const v = this.map.get(key);
    return v?.type === "bytes" ? (v.value as Uint8Array) : null;
  }
  async setBytes(key: string, value: Uint8Array): Promise<void> {
    this.map.set(key, { type: "bytes", value });
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
}

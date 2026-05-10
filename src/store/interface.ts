// Minimal key-value storage interface used across the SDK. Keeps the SDK core
// platform-agnostic — concrete implementations live in store/*-adapter.ts.
//
// Keys are namespaced strings (e.g. "deviceId", "session/<peer_user>/<peer_device>").
// Values are bytes (Uint8Array) or strings — adapters serialize as needed.

export interface KVStore {
  getString(key: string): Promise<string | null>;
  setString(key: string, value: string): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | null>;
  setBytes(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** List keys with the given prefix. Used to enumerate per-peer-device sessions. */
  listKeys(prefix: string): Promise<string[]>;
}

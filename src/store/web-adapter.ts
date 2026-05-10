// IndexedDB-backed KVStore for browsers. Single object store keyed by string,
// values are { type: "string"|"bytes", value }. Async API; the SDK awaits.
//
// Tests typically use the in-memory adapter to avoid the IndexedDB dependency
// in unit tests; real IndexedDB is exercised in browser-mode integration tests.

import type { KVStore } from "./interface.js";

const DB_NAME = "dtelecom-secure-chat";
const STORE = "kv";
const VERSION = 1;

interface StoredValue {
  type: "string" | "bytes";
  value: string | Uint8Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | T,
): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => {
      // result may be an IDBRequest (success path) or already a value.
      if (result && typeof result === "object" && "result" in result) {
        resolve((result as IDBRequest<T>).result);
      } else {
        resolve(result as T);
      }
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class WebKVStore implements KVStore {
  async getString(key: string): Promise<string | null> {
    const v = await withStore("readonly", (s) => s.get(key));
    if (!v) return null;
    const sv = v as unknown as StoredValue;
    return sv.type === "string" ? (sv.value as string) : null;
  }

  async setString(key: string, value: string): Promise<void> {
    const sv: StoredValue = { type: "string", value };
    await withStore("readwrite", (s) => s.put(sv, key));
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const v = await withStore("readonly", (s) => s.get(key));
    if (!v) return null;
    const sv = v as unknown as StoredValue;
    return sv.type === "bytes" ? (sv.value as Uint8Array) : null;
  }

  async setBytes(key: string, value: Uint8Array): Promise<void> {
    const sv: StoredValue = { type: "bytes", value };
    await withStore("readwrite", (s) => s.put(sv, key));
  }

  async delete(key: string): Promise<void> {
    await withStore("readwrite", (s) => s.delete(key));
  }

  async listKeys(prefix: string): Promise<string[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const out: string[] = [];
      const tx = db.transaction(STORE, "readonly");
      const cursorReq = tx.objectStore(STORE).openKeyCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        const k = cursor.key as string;
        if (k.startsWith(prefix)) out.push(k);
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }
}

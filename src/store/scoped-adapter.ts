// Scoped wrapper around any KVStore. Prefixes every key with `u/<scope>/`
// so the SDK's persistent state is isolated per user, even when multiple
// users share the same underlying storage (MMKV instance / IndexedDB).
//
// All SDK subsystems take a `KVStore`; wrapping at connect() time means
// downstream code (DeviceId, MessageStore, ConversationIndex, Olm pickle,
// SessionManager, KeyBundleManager) is target-agnostic — they see keys
// like `"deviceId"` and `"convindex/<peer>"` exactly as before; the
// wrapper handles the user prefix transparently.
//
// Why this matters: dmeet's chat state lives across user sign-outs (the
// app doesn't wipe storage on logout). Before this wrapper, signing in
// as user B on a device that previously hosted user A inherited A's
// device id, Olm sessions, message history, and conversation index —
// silent cross-user data leak. With the wrapper, B sees an empty
// namespace at `u/<B>/...` while A's data stays sealed at `u/<A>/...`,
// untouched and inaccessible to B.

import type { KVStore } from "./interface.js";

const SCOPE_PREFIX = "u/";
const SCOPE_SEP = "/";

/**
 * The current SDK prefix for a user. Exposed so the migration helper +
 * `wipeUserData` can enumerate / delete the right namespace without
 * having to instantiate a ScopedKVStore.
 */
export function scopePrefix(scope: string): string {
  return `${SCOPE_PREFIX}${scope}${SCOPE_SEP}`;
}

export class ScopedKVStore implements KVStore {
  private readonly prefix: string;

  constructor(private readonly inner: KVStore, readonly scope: string) {
    if (!scope) {
      // An empty scope would map every key to `u//key` — works mechanically
      // but defeats the whole point. Catch it at construction.
      throw new Error("ScopedKVStore: empty scope");
    }
    this.prefix = scopePrefix(scope);
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  getString(key: string): Promise<string | null> {
    return this.inner.getString(this.k(key));
  }

  setString(key: string, value: string): Promise<void> {
    return this.inner.setString(this.k(key), value);
  }

  getBytes(key: string): Promise<Uint8Array | null> {
    return this.inner.getBytes(this.k(key));
  }

  setBytes(key: string, value: Uint8Array): Promise<void> {
    return this.inner.setBytes(this.k(key), value);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(this.k(key));
  }

  async listKeys(prefix: string): Promise<string[]> {
    const raw = await this.inner.listKeys(this.k(prefix));
    return raw.map((k) => k.slice(this.prefix.length));
  }
}

/**
 * One-shot migration for installs that predate the scoped wrapper. If
 * the scoped namespace is empty AND the underlying store contains any
 * unscoped (legacy) keys, copy them into the scoped namespace.
 *
 * "Unscoped" = any top-level key that does NOT start with `u/`. We
 * deliberately don't touch keys belonging to OTHER scopes (`u/<other>/...`)
 * so siblings stay isolated.
 *
 * Returns the number of keys migrated (for logging/telemetry).
 */
export async function migrateLegacyKeys(
  raw: KVStore,
  scope: string,
): Promise<number> {
  const scoped = new ScopedKVStore(raw, scope);
  const existingInScope = await scoped.listKeys("");
  if (existingInScope.length > 0) {
    // The scoped namespace already has data — either we've already run,
    // or this is a fresh user with their own data. Either way, don't
    // adopt unscoped leftovers; they belong to whoever the previous
    // single-user install was for, and we can't know that's the same
    // user now signing in.
    return 0;
  }

  const allKeys = await raw.listKeys("");
  const legacy = allKeys.filter((k) => !k.startsWith(SCOPE_PREFIX));
  if (legacy.length === 0) {
    return 0;
  }

  let migrated = 0;
  for (const key of legacy) {
    // Try bytes first (no-op for string-only values: getBytes returns
    // null/whatever the adapter does for non-byte keys). Fall back to
    // string. Adapters that store everything as bytes (mmkv-adapter)
    // hit the first branch; adapters that store strings as strings
    // (web-adapter / memory) hit the second.
    const bytes = await raw.getBytes(key);
    if (bytes !== null) {
      await scoped.setBytes(key, bytes);
      await raw.delete(key);
      migrated++;
      continue;
    }
    const str = await raw.getString(key);
    if (str !== null) {
      await scoped.setString(key, str);
      await raw.delete(key);
      migrated++;
    }
  }
  return migrated;
}

/**
 * Enumerate + delete every key under `u/<userId>/`. Use on sign-out to
 * reclaim space (the scoped namespace is otherwise inert and would
 * accumulate over time as users come and go on a shared device).
 *
 * Does not touch other users' data, even on the same KV instance.
 */
export async function wipeScope(raw: KVStore, scope: string): Promise<number> {
  const scoped = new ScopedKVStore(raw, scope);
  const keys = await scoped.listKeys("");
  for (const k of keys) {
    await scoped.delete(k);
  }
  return keys.length;
}

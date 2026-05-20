// Pre-decrypt envelopeUuid dedup for the at-least-once delivery semantics
// the dtelecom node uses (sender-side retry within fallbackTimeout + one
// post-webhook republish). Without this, an envelope arriving twice would
// fail Olm replay detection on the second decrypt — and the SDK's existing
// "decrypt failed" handler treats that as session corruption and calls
// forgetPeerDevice, breaking the session for all future messages.
//
// Keyed on envelopeUuid. Persisted under "envelopeDedup/<uuid>" in the
// scoped store (so sign-out / wipeUserData clears it for free, and a
// crash mid-decrypt doesn't re-trigger the heavy Olm replay-recovery
// path on the same ciphertext after restart).
//
// LRU by insertion order. 1000 entries × ~80 bytes/row ≈ 80KB ceiling per
// user. Genuine duplicates from the retry path arrive within ~2-3 seconds,
// never 1000+ envelopes apart — the cap exists to bound storage, not to
// dedupe across long windows.

import { silentLogger, type Logger } from "./logging.js";
import type { KVStore } from "./store/interface.js";

const KEY_PREFIX = "envelopeDedup/";
const CAP = 1000;

export class EnvelopeDedup {
  // In-memory mirror of the persisted entries. Map preserves insertion
  // order, which we use as the LRU eviction order.
  private cache = new Map<string, number>(); // uuid → addedAtMs
  private initialized = false;
  private log: Logger;

  constructor(private store: KVStore, log?: Logger) {
    this.log = log ?? silentLogger();
  }

  /** For chat.getDiagnostics() — size only, no uuids leaked. */
  size(): number {
    return this.cache.size;
  }

  /**
   * Hydrate from persisted storage. Idempotent — safe to call from any
   * bootstrap path. Trims any over-cap state inherited from a previous
   * version.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    const keys = await this.store.listKeys(KEY_PREFIX);
    // Pull timestamps and sort ascending so the most-recently-added end
    // up last in the Map (matches eviction order).
    const entries: Array<[string, number]> = [];
    for (const k of keys) {
      const uuid = k.slice(KEY_PREFIX.length);
      const raw = await this.store.getString(k);
      const ts = raw ? Number(raw) : 0;
      entries.push([uuid, Number.isFinite(ts) ? ts : 0]);
    }
    entries.sort((a, b) => a[1] - b[1]);
    for (const [uuid, ts] of entries) {
      this.cache.set(uuid, ts);
    }
    await this.trim();
    this.initialized = true;
  }

  /** True if this envelopeUuid has been seen (and added) before. */
  async has(uuid: string): Promise<boolean> {
    if (!this.initialized) await this.init();
    const hit = this.cache.has(uuid);
    if (hit) this.log.debug("dedup.has: hit (dropping duplicate)", { uuid });
    return hit;
  }

  /**
   * Record that this envelopeUuid has been processed. Idempotent on
   * re-add (does not refresh the LRU position — first-seen is sticky).
   * Trims one oldest entry on overflow.
   */
  async add(uuid: string): Promise<void> {
    if (!this.initialized) await this.init();
    if (this.cache.has(uuid)) return;
    const now = Date.now();
    this.cache.set(uuid, now);
    await this.store.setString(KEY_PREFIX + uuid, String(now));
    if (this.cache.size > CAP) {
      await this.trim();
    }
    this.log.debug("dedup.add", { uuid, size: this.cache.size });
  }

  /**
   * Roll back a previously-added uuid. Called by the SDK when decrypt
   * or dispatch failed AFTER the pre-decrypt add, so the at-least-once
   * delivery layer (sender retries + post-webhook publish + drainPending
   * on next reconnect) can attempt re-processing. Without this, a single
   * decrypt failure permanently poisons the dedup and the message is
   * lost on every redelivery.
   *
   * No-op if the uuid isn't in the cache.
   */
  async remove(uuid: string): Promise<void> {
    if (!this.initialized) await this.init();
    if (!this.cache.has(uuid)) return;
    this.cache.delete(uuid);
    await this.store.delete(KEY_PREFIX + uuid);
    this.log.info("dedup.remove (rollback on processing failure)", {
      uuid, size: this.cache.size,
    });
  }

  /** Drop oldest entries until size ≤ CAP. */
  private async trim(): Promise<void> {
    while (this.cache.size > CAP) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
      await this.store.delete(KEY_PREFIX + oldest);
    }
  }
}

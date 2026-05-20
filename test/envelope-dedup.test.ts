// EnvelopeDedup — pre-decrypt deduplication + rollback on processing
// failure. Added in 0.12.1: without the rollback, a first-delivery
// decrypt failure permanently poisoned the dedup and every subsequent
// redelivery of the same envelope was silently dropped. The receiver
// never saw the message; the sender's at-least-once retries all fired
// to no effect.

import { describe, expect, it } from "vitest";
import { EnvelopeDedup } from "../src/envelope_dedup.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";

describe("EnvelopeDedup", () => {
  it("has() returns false for unseen uuid; add() marks as seen", async () => {
    const store = new MemoryKVStore();
    const dedup = new EnvelopeDedup(store);
    expect(await dedup.has("u1")).toBe(false);
    await dedup.add("u1");
    expect(await dedup.has("u1")).toBe(true);
  });

  it("add() is idempotent — second add is a no-op", async () => {
    const store = new MemoryKVStore();
    const dedup = new EnvelopeDedup(store);
    await dedup.add("u1");
    await dedup.add("u1");
    expect(await dedup.has("u1")).toBe(true);
    // KV store should only have one entry for this uuid.
    const keys = await store.listKeys("envelopeDedup/");
    expect(keys).toEqual(["envelopeDedup/u1"]);
  });

  it("remove() rolls back a previously-added uuid (0.12.1 fix)", async () => {
    const store = new MemoryKVStore();
    const dedup = new EnvelopeDedup(store);
    await dedup.add("u1");
    expect(await dedup.has("u1")).toBe(true);
    await dedup.remove("u1");
    expect(await dedup.has("u1")).toBe(false);
    // KV row also gone — confirms persistence rolled back.
    const keys = await store.listKeys("envelopeDedup/");
    expect(keys).toEqual([]);
  });

  it("remove() of unknown uuid is a no-op", async () => {
    const store = new MemoryKVStore();
    const dedup = new EnvelopeDedup(store);
    await dedup.remove("never-added");
    expect(await dedup.has("never-added")).toBe(false);
  });

  it("survives reload — persisted in KV under envelopeDedup/ prefix", async () => {
    const store = new MemoryKVStore();
    {
      const dedup1 = new EnvelopeDedup(store);
      await dedup1.add("u1");
      await dedup1.add("u2");
    }
    // New instance, same store — should hydrate from KV.
    const dedup2 = new EnvelopeDedup(store);
    expect(await dedup2.has("u1")).toBe(true);
    expect(await dedup2.has("u2")).toBe(true);
    expect(await dedup2.has("u3")).toBe(false);
  });

  it("removed uuid does NOT survive reload (persistence rollback worked)", async () => {
    const store = new MemoryKVStore();
    {
      const dedup1 = new EnvelopeDedup(store);
      await dedup1.add("u1");
      await dedup1.remove("u1");
    }
    const dedup2 = new EnvelopeDedup(store);
    expect(await dedup2.has("u1")).toBe(false);
    // The whole point of the 0.12.1 fix: a rolled-back uuid can be
    // re-attempted on next delivery (sender retry or drainPending).
  });
});

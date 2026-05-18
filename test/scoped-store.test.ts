// Unit tests for ScopedKVStore + the migration / wipe helpers. These are
// pure store-level tests — no SDK fixture, no Olm. They lock the
// per-user-namespace contract so future refactors can't silently regress.

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryKVStore } from "../src/store/memory-adapter.js";
import {
  migrateLegacyKeys,
  ScopedKVStore,
  scopePrefix,
  wipeScope,
} from "../src/store/scoped-adapter.js";

describe("ScopedKVStore", () => {
  let raw: MemoryKVStore;
  beforeEach(() => {
    raw = new MemoryKVStore();
  });

  it("prefixes writes with `u/<scope>/` and unprefixes reads", async () => {
    const alice = new ScopedKVStore(raw, "alice");
    await alice.setString("deviceId", "abc");

    // Caller sees the unprefixed key:
    expect(await alice.getString("deviceId")).toBe("abc");
    // The underlying store carries the prefix:
    expect(await raw.getString("u/alice/deviceId")).toBe("abc");
    expect(await raw.getString("deviceId")).toBeNull();
  });

  it("isolates two scopes sharing the same backing store", async () => {
    const alice = new ScopedKVStore(raw, "alice");
    const bob = new ScopedKVStore(raw, "bob");

    await alice.setString("deviceId", "alice-device");
    await bob.setString("deviceId", "bob-device");

    expect(await alice.getString("deviceId")).toBe("alice-device");
    expect(await bob.getString("deviceId")).toBe("bob-device");

    await bob.delete("deviceId");
    // Alice's data is unaffected by bob's delete:
    expect(await alice.getString("deviceId")).toBe("alice-device");
    expect(await bob.getString("deviceId")).toBeNull();
  });

  it("listKeys strips the scope prefix from results", async () => {
    const alice = new ScopedKVStore(raw, "alice");
    await alice.setString("convindex/peer1", "{}");
    await alice.setString("convindex/peer2", "{}");
    await alice.setString("deviceId", "abc");

    const conv = await alice.listKeys("convindex/");
    expect(new Set(conv)).toEqual(new Set(["convindex/peer1", "convindex/peer2"]));

    const all = await alice.listKeys("");
    expect(all.length).toBe(3);
    expect(all.every((k) => !k.startsWith("u/"))).toBe(true);
  });

  it("listKeys does not leak other scopes' keys", async () => {
    const alice = new ScopedKVStore(raw, "alice");
    const bob = new ScopedKVStore(raw, "bob");
    await alice.setString("a", "1");
    await bob.setString("b", "2");

    expect(await alice.listKeys("")).toEqual(["a"]);
    expect(await bob.listKeys("")).toEqual(["b"]);
  });

  it("byte values round-trip through the scoped wrapper", async () => {
    const alice = new ScopedKVStore(raw, "alice");
    const blob = new Uint8Array([1, 2, 3, 0, 255]);
    await alice.setBytes("k", blob);
    const back = await alice.getBytes("k");
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual([1, 2, 3, 0, 255]);
  });

  it("throws on empty scope (catches misconfiguration early)", () => {
    expect(() => new ScopedKVStore(raw, "")).toThrow(/empty scope/);
  });

  it("scopePrefix returns the right shape", () => {
    expect(scopePrefix("alice")).toBe("u/alice/");
  });
});

describe("migrateLegacyKeys", () => {
  let raw: MemoryKVStore;
  beforeEach(() => {
    raw = new MemoryKVStore();
  });

  it("moves pre-existing unscoped keys into the user's scope on first run", async () => {
    // Simulate a 0.8.x install — top-level keys with no scope prefix.
    await raw.setString("deviceId", "legacy-device");
    await raw.setString("convindex/peer1", "{}");
    await raw.setBytes("olm/account", new Uint8Array([42, 7]));

    const migrated = await migrateLegacyKeys(raw, "alice");
    expect(migrated).toBe(3);

    // Old top-level keys are GONE — not just shadowed:
    expect(await raw.getString("deviceId")).toBeNull();
    expect(await raw.getString("convindex/peer1")).toBeNull();
    expect(await raw.getBytes("olm/account")).toBeNull();

    // They now live under u/alice/:
    expect(await raw.getString("u/alice/deviceId")).toBe("legacy-device");
    expect(await raw.getString("u/alice/convindex/peer1")).toBe("{}");
    const bytes = await raw.getBytes("u/alice/olm/account");
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!)).toEqual([42, 7]);
  });

  it("is a no-op when the scoped namespace already has data", async () => {
    // Legacy keys present...
    await raw.setString("deviceId", "legacy-device");
    // ...AND alice has already started using the scoped namespace:
    await raw.setString("u/alice/deviceId", "scoped-device");

    const migrated = await migrateLegacyKeys(raw, "alice");
    expect(migrated).toBe(0);

    // Legacy "deviceId" stays untouched (we won't adopt it because we
    // can't know it belongs to alice; could belong to a previous user):
    expect(await raw.getString("deviceId")).toBe("legacy-device");
    expect(await raw.getString("u/alice/deviceId")).toBe("scoped-device");
  });

  it("ignores other users' scoped data when migrating", async () => {
    await raw.setString("deviceId", "legacy");
    await raw.setString("u/bob/deviceId", "bobs-device");

    const migrated = await migrateLegacyKeys(raw, "alice");
    expect(migrated).toBe(1);

    expect(await raw.getString("u/alice/deviceId")).toBe("legacy");
    // Bob's data must NOT be touched:
    expect(await raw.getString("u/bob/deviceId")).toBe("bobs-device");
  });

  it("returns 0 when there is nothing to migrate", async () => {
    expect(await migrateLegacyKeys(raw, "alice")).toBe(0);
  });
});

describe("wipeScope", () => {
  it("deletes every key under u/<scope>/ and leaves other scopes alone", async () => {
    const raw = new MemoryKVStore();
    const alice = new ScopedKVStore(raw, "alice");
    const bob = new ScopedKVStore(raw, "bob");

    await alice.setString("deviceId", "a1");
    await alice.setString("convindex/peer", "{}");
    await bob.setString("deviceId", "b1");

    const deleted = await wipeScope(raw, "alice");
    expect(deleted).toBe(2);

    expect(await alice.listKeys("")).toEqual([]);
    expect(await bob.getString("deviceId")).toBe("b1");
  });

  it("is idempotent — second call returns 0", async () => {
    const raw = new MemoryKVStore();
    const alice = new ScopedKVStore(raw, "alice");
    await alice.setString("k", "v");

    expect(await wipeScope(raw, "alice")).toBe(1);
    expect(await wipeScope(raw, "alice")).toBe(0);
  });
});

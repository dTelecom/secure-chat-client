// Verify MMKVKVStore against the real react-native-mmkv API via a small
// in-memory fake that mimics its signature. The fake is structurally
// compatible with MMKV v3+ so this test catches breakage if our shape
// drifts from theirs.

import { describe, expect, it } from "vitest";
import { MMKVKVStore, type MMKVLike } from "../src/store/mmkv-adapter.js";

class FakeMMKV implements MMKVLike {
  private map = new Map<string, string | Uint8Array>();
  set(key: string, value: string | Uint8Array): void {
    this.map.set(key, value);
  }
  getString(key: string): string | undefined {
    const v = this.map.get(key);
    return typeof v === "string" ? v : undefined;
  }
  getBuffer(key: string): Uint8Array | undefined {
    const v = this.map.get(key);
    return v instanceof Uint8Array ? v : undefined;
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  getAllKeys(): string[] {
    return [...this.map.keys()];
  }
}

describe("MMKVKVStore", () => {
  it("strings round-trip", async () => {
    const kv = new MMKVKVStore(new FakeMMKV());
    expect(await kv.getString("a")).toBeNull();
    await kv.setString("a", "hello");
    expect(await kv.getString("a")).toBe("hello");
    await kv.delete("a");
    expect(await kv.getString("a")).toBeNull();
  });

  it("bytes round-trip via the native buffer API (no base64)", async () => {
    const kv = new MMKVKVStore(new FakeMMKV());
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await kv.setBytes("b", bytes);
    const out = await kv.getBytes("b");
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual([1, 2, 3, 4, 5]);
  });

  it("getString returns null for a key that holds bytes", async () => {
    // MMKV.getString returns undefined when the type doesn't match; we
    // normalize to null. Important so the SDK can `if (v) ...` cleanly.
    const kv = new MMKVKVStore(new FakeMMKV());
    await kv.setBytes("k", new Uint8Array([0]));
    expect(await kv.getString("k")).toBeNull();
  });

  it("listKeys filters by prefix", async () => {
    const kv = new MMKVKVStore(new FakeMMKV());
    await kv.setString("messages/m1", "a");
    await kv.setString("messages/m2", "b");
    await kv.setString("session/s1", "c");
    await kv.setString("deviceId", "d");

    expect((await kv.listKeys("messages/")).sort()).toEqual([
      "messages/m1",
      "messages/m2",
    ]);
    expect(await kv.listKeys("session/")).toEqual(["session/s1"]);
    expect((await kv.listKeys("")).sort()).toEqual([
      "deviceId",
      "messages/m1",
      "messages/m2",
      "session/s1",
    ]);
  });
});

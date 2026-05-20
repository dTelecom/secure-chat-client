// Edit window enforcement — sender AND receiver. 24h ceiling.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatError, DTelecomSecureChat, EDIT_WINDOW_MS } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import { MessageStore } from "../src/message_store.js";
import { ScopedKVStore } from "../src/store/scoped-adapter.js";
import type { MintTokenResponse } from "../src/types.js";

const realWebSocket = globalThis.WebSocket;

class NeverConnectingWs {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send(_data: string): void {}
  close(): void {
    this.readyState = NeverConnectingWs.CLOSED;
    queueMicrotask(() => this.onclose?.(new Event("close") as CloseEvent));
  }
  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = NeverConnectingWs.OPEN;
      this.onopen?.(new Event("open"));
    });
  }
}

beforeEach(() => {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    NeverConnectingWs as unknown as typeof WebSocket;
});
afterEach(() => {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = realWebSocket;
});

const FAKE_JWT_ALICE =
  "header." + btoaUrl(JSON.stringify({ sub: "alice", did: "alice-dev", exp: 9999999999 })) + ".sig";
function btoaUrl(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function makeFetch(): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") return jsonOk({ ok: true });
    if (u.pathname === "/keys/count") return jsonOk({ count: 100 });
    if (u.pathname === "/keys/claim_all") return jsonOk({ devices: [] });
    if (u.pathname === "/envelopes/pending") return jsonOk({ envelopes: [] });
    return new Response(JSON.stringify({ error: "not_implemented" }), { status: 501 });
  };
}

function mintAlice(): MintTokenResponse {
  return { chatToken: FAKE_JWT_ALICE, expiresAt: 9999999999, chatNodeWsUrl: "wss://fake/chat/ws" };
}

async function connectAlice(store: MemoryKVStore): Promise<DTelecomSecureChat> {
  return DTelecomSecureChat.connect({
    apiBaseURL: "http://test",
    selfUserId: "alice",
    fetchChatToken: async () => mintAlice(),
    fetchHttpBearer: async () => "fake.bearer",
    store,
    crypto: new FakeCryptoAdapter(),
    fetchImpl: makeFetch(),
  });
}

const scopedAlice = (kv: MemoryKVStore) => new ScopedKVStore(kv, "alice");

describe("editMessage — sender-side enforcement", () => {
  it("editMessage throws not_found for an unknown messageId", async () => {
    const store = new MemoryKVStore();
    const sdk = await connectAlice(store);
    await expect(sdk.editMessage("bob", "missing-id", "new text"))
      .rejects.toThrow(/not in local store/);
    try {
      await sdk.editMessage("bob", "missing-id", "new text");
    } catch (e) {
      expect((e as ChatError).code).toBe("not_found");
    }
    await sdk.disconnect();
  });

  it("editMessage throws not_authorized when target was authored by the peer", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.put({
      id: "m1",
      peerUserId: "bob",
      senderUserId: "bob",   // peer authored
      text: "peer message",
      sentAt: Date.now(),
      editedAt: null,
      deletedAt: null,
    });

    const sdk = await connectAlice(store);
    try {
      await sdk.editMessage("bob", "m1", "tampered");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ChatError).code).toBe("not_authorized");
    }
    await sdk.disconnect();
  });

  it("editMessage throws edit_window_expired when message is older than EDIT_WINDOW_MS", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    const tooOld = Date.now() - EDIT_WINDOW_MS - 1_000;
    await messages.put({
      id: "stale",
      peerUserId: "bob",
      senderUserId: "alice",
      text: "ancient",
      sentAt: tooOld,
      editedAt: null,
      deletedAt: null,
    });

    const sdk = await connectAlice(store);
    try {
      await sdk.editMessage("bob", "stale", "new");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ChatError).code).toBe("edit_window_expired");
    }
    // Original text should be intact.
    const after = await sdk.getHistory("bob");
    const target = after.find((m) => m.id === "stale")!;
    expect(target.text).toBe("ancient");
    expect(target.editedAt).toBeNull();
    await sdk.disconnect();
  });

  it("editMessage succeeds within the 24h window (peer_unreachable still surfaces because no peer devices)", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    const recent = Date.now() - 1_000;
    await messages.put({
      id: "fresh",
      peerUserId: "bob",
      senderUserId: "alice",
      text: "original",
      sentAt: recent,
      editedAt: null,
      deletedAt: null,
    });
    const sdk = await connectAlice(store);
    // Window check passes; we then hit the wire path where claim_all
    // returns []. That yields peer_unreachable. The crucial assertion is
    // that the error code is NOT edit_window_expired — the window check
    // gave the green light.
    try {
      await sdk.editMessage("bob", "fresh", "edited");
      // No throw → SDK actually applied locally first which is fine.
    } catch (e) {
      expect((e as ChatError).code).toBe("peer_unreachable");
    }
    await sdk.disconnect();
  });
});

describe("MessageStore.applyEdit — receiver-side enforcement", () => {
  it("applies the edit when editedAt - sentAt <= EDIT_WINDOW_MS", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    const original = {
      id: "m",
      peerUserId: "bob",
      senderUserId: "bob",
      text: "old",
      sentAt: 1_000_000,
      editedAt: null,
      deletedAt: null,
    };
    await messages.put(original);
    const updated = await messages.applyEdit({
      targetId: "m",
      editorUserId: "bob",
      newText: "new",
      editedAt: 1_000_000 + 1_000, // 1s later, well within
    });
    expect(updated).not.toBeNull();
    expect(updated!.text).toBe("new");
    expect(updated!.editedAt).toBe(1_000_000 + 1_000);
  });

  it("rejects edit past EDIT_WINDOW_MS (defends against clock-skewed sender)", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    const original = {
      id: "m",
      peerUserId: "bob",
      senderUserId: "bob",
      text: "old",
      sentAt: 1_000_000,
      editedAt: null,
      deletedAt: null,
    };
    await messages.put(original);
    const updated = await messages.applyEdit({
      targetId: "m",
      editorUserId: "bob",
      newText: "tampered",
      editedAt: 1_000_000 + EDIT_WINDOW_MS + 1, // 1ms past the window
    });
    expect(updated).toBeNull();
    const after = await messages.get("m");
    expect(after!.text).toBe("old");
    expect(after!.editedAt).toBeNull();
  });

  it("rejects edit by non-original-sender", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.put({
      id: "m",
      peerUserId: "bob",
      senderUserId: "bob",
      text: "old",
      sentAt: 1_000_000,
      editedAt: null,
      deletedAt: null,
    });
    const updated = await messages.applyEdit({
      targetId: "m",
      editorUserId: "carol", // not the original sender
      newText: "tampered",
      editedAt: 1_000_000 + 1_000,
    });
    expect(updated).toBeNull();
  });

  it("rejects edit on a tombstoned message", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.put({
      id: "m",
      peerUserId: "bob",
      senderUserId: "bob",
      text: "",
      sentAt: 1_000_000,
      editedAt: null,
      deletedAt: 1_000_000 + 100,
    });
    const updated = await messages.applyEdit({
      targetId: "m",
      editorUserId: "bob",
      newText: "resurrect",
      editedAt: 1_000_000 + 200,
    });
    expect(updated).toBeNull();
  });
});

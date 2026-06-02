// Regression test for content-type-aware push suppression.
//
// The SDK sets `notifyPush: false` on chatSend frames whose decrypted
// content shouldn't wake the recipient via push notification. The
// node ANDs this hint with its presence-based push decision and sets
// the webhook body's `push: false` when the SDK opts out. Backend is
// unchanged — it just sees more `push: false` envelopes.
//
// The only event type that SHOULD trigger push is `text`. Everything
// else (edit, delete, chatDeleteAll, selfEcho wrapping anything, read,
// received, typing) must omit `notifyPush` only by being explicit
// `false`.
//
// Wire-emit rule: `notifyPush` is serialized only when explicitly
// false. Absent field = legacy default = push allowed. This keeps
// older nodes (that don't parse the field) compatible with new SDKs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import { MessageStore } from "../src/message_store.js";
import { ScopedKVStore } from "../src/store/scoped-adapter.js";
import type { MintTokenResponse } from "../src/types.js";

const realWebSocket = globalThis.WebSocket;
let sentFrames: unknown[] = [];

class CapturingWs {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send(data: string): void {
    try {
      sentFrames.push(JSON.parse(data));
    } catch {
      // ignore
    }
  }
  close(): void {
    this.readyState = CapturingWs.CLOSED;
    queueMicrotask(() => this.onclose?.(new Event("close") as CloseEvent));
  }
  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = CapturingWs.OPEN;
      this.onopen?.(new Event("open"));
    });
  }
}

beforeEach(() => {
  sentFrames = [];
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    CapturingWs as unknown as typeof WebSocket;
});
afterEach(() => {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = realWebSocket;
});

function fakeBundle(deviceId: string) {
  return {
    deviceId,
    identityKeyCurve: `ik-curve-${deviceId}`,
    identityKeyEd: `ik-ed-${deviceId}`,
    signedPrekey: `spk-${deviceId}`,
    signedPrekeySig: `spk-sig-${deviceId}`,
    oneTimeKey: { id: `otk-${deviceId}`, public: `otk-pub-${deviceId}` },
    fallbackPrekey: `fb-${deviceId}`,
    fallbackPrekeySig: `fb-sig-${deviceId}`,
    fingerprint: `fp-${deviceId}`,
    lastActiveAt: 0,
  };
}

function makeFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") return jsonOk({ ok: true });
    if (u.pathname === "/keys/count") return jsonOk({ count: 100 });
    if (u.pathname === "/keys/claim_all") {
      const body = init?.body ? (JSON.parse(String(init.body)) as { peerUserId?: string }) : {};
      if (body.peerUserId === "bob") return jsonOk({ devices: [fakeBundle("bob-dev")] });
      return jsonOk({ devices: [] });
    }
    if (u.pathname === "/envelopes/pending") return jsonOk({ envelopes: [] });
    if (u.pathname === "/envelopes/ack") return jsonOk({ ok: true });
    if (u.pathname === "/keys/list_devices") {
      return jsonOk({ devices: [{ deviceId: "bob-dev", fingerprint: "fp-bob-dev", lastActiveAt: 0 }] });
    }
    return new Response(JSON.stringify({ error: "not_implemented", path: u.pathname }), {
      status: 501,
      headers: { "content-type": "application/json" },
    });
  };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const FAKE_JWT =
  "header." + btoaUrl(JSON.stringify({ sub: "alice", did: "alice-dev", exp: 9999999999 })) + ".sig";

function btoaUrl(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mintAlice(): MintTokenResponse {
  return { chatToken: FAKE_JWT, expiresAt: 9999999999, chatNodeWsUrl: "wss://fake/chat/ws" };
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

interface CapturedChatSend {
  kind: "chatSend";
  toUserId: string;
  ephemeral?: boolean;
  notifyPush?: boolean;
  msgType?: string;
  targets: Array<{ deviceId: string; ciphertext: string; envelopeUuid: string }>;
}

function chatSendsTo(toUserId: string): CapturedChatSend[] {
  return sentFrames.filter(
    (f): f is CapturedChatSend =>
      (f as { kind?: string }).kind === "chatSend" && (f as CapturedChatSend).toUserId === toUserId,
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("notifyPush wire flag — only text is push-worthy", () => {
  it("sendText omits notifyPush (= legacy default, push allowed)", async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);

    await alice.sendText("bob", "hello");
    await waitFor(() => chatSendsTo("bob").length >= 1);

    const sends = chatSendsTo("bob");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    // Wire-emit rule: notifyPush is only serialized when explicitly
    // false. For text, the field must be absent so older nodes treat
    // it as the legacy "push allowed" default.
    for (const s of sends) {
      expect(s.notifyPush, "sendText must NOT set notifyPush — absent field = legacy push-allowed default")
        .toBeUndefined();
    }

    await alice.disconnect();
  });

  it("editMessage sets notifyPush: false", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(new ScopedKVStore(store, "alice"));
    // Seed a fresh own-sent message so editMessage's window check passes.
    await messages.put({
      id: "msg-1",
      peerUserId: "bob",
      senderUserId: "alice",
      text: "original",
      sentAt: Date.now() - 1000,
      editedAt: null,
      deletedAt: null,
    });
    const alice = await connectAlice(store);

    try {
      await alice.editMessage("bob", "msg-1", "edited");
    } catch {
      // peer_unreachable etc. is fine — we only care that the chatSend
      // frame was emitted with the right notifyPush flag.
    }
    await waitFor(() => chatSendsTo("bob").length >= 1);

    const sends = chatSendsTo("bob");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) {
      expect(s.notifyPush).toBe(false);
    }

    await alice.disconnect();
  });

  it("deleteMessage sets notifyPush: false", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(new ScopedKVStore(store, "alice"));
    await messages.put({
      id: "msg-2",
      peerUserId: "bob",
      senderUserId: "alice",
      text: "to delete",
      sentAt: Date.now() - 1000,
      editedAt: null,
      deletedAt: null,
    });
    const alice = await connectAlice(store);

    try {
      await alice.deleteMessage("bob", "msg-2");
    } catch {
      // ignore peer-side errors
    }
    await waitFor(() => chatSendsTo("bob").length >= 1);

    const sends = chatSendsTo("bob");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) {
      expect(s.notifyPush).toBe(false);
    }

    await alice.disconnect();
  });

  it("deleteConversationForEveryone sets notifyPush: false", async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);

    try {
      await alice.deleteConversationForEveryone("bob");
    } catch {
      // ignore
    }
    await waitFor(() => chatSendsTo("bob").length >= 1);

    const sends = chatSendsTo("bob");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) {
      expect(s.notifyPush).toBe(false);
    }

    await alice.disconnect();
  });

  it("markRead sets notifyPush:false on a durable wire path (no ephemeral)", async () => {
    // 0.13.6: markRead reverted from ephemeral:true back to durable
    // so offline sibling devices drain the read receipt via
    // /envelopes/pending on reconnect. notifyPush:false handles push
    // suppression at the node-side AND-gate. See receipts-durable
    // and multi-device-receipt-sync tests for the multi-device bug
    // that motivated the revert.
    const store = new MemoryKVStore();
    const messages = new MessageStore(new ScopedKVStore(store, "alice"));
    await messages.put({
      id: "inbound-1",
      peerUserId: "bob",
      senderUserId: "bob",
      text: "hi alice",
      sentAt: Date.now() - 1000,
      editedAt: null,
      deletedAt: null,
    });
    const alice = await connectAlice(store);

    await alice.markRead("bob", "inbound-1");
    await waitFor(() => chatSendsTo("bob").length >= 1);

    const sends = chatSendsTo("bob");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) {
      expect(s.notifyPush).toBe(false);
      // ephemeral is wire-emitted only when true (`opts.ephemeral || undefined`)
      // so the durable path leaves it undefined on the parsed frame.
      expect(s.ephemeral).toBeUndefined();
    }

    await alice.disconnect();
  });

  it("typing sets notifyPush: false (and ephemeral: true)", async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);

    // First send to bootstrap a session, then trigger typing.
    await alice.sendText("bob", "hi");
    await waitFor(() => chatSendsTo("bob").length >= 1);
    const baseline = chatSendsTo("bob").length;

    alice.setTyping("bob", true);
    await waitFor(() => chatSendsTo("bob").length > baseline);

    const newFrames = chatSendsTo("bob").slice(baseline);
    expect(newFrames.length).toBeGreaterThanOrEqual(1);
    // Typing frames are ephemeral + notifyPush:false.
    const typingFrames = newFrames.filter((f) => f.ephemeral === true);
    expect(typingFrames.length).toBeGreaterThanOrEqual(1);
    for (const f of typingFrames) {
      expect(f.notifyPush).toBe(false);
    }

    await alice.disconnect();
  });

  it("retrySend (text re-send) omits notifyPush like sendText", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(new ScopedKVStore(store, "alice"));
    // Seed a failed message so retrySend's status check passes.
    await messages.put({
      id: "failed-1",
      peerUserId: "bob",
      senderUserId: "alice",
      text: "retry me",
      sentAt: Date.now() - 1000,
      editedAt: null,
      deletedAt: null,
      status: "failed",
    });
    const alice = await connectAlice(store);

    try {
      await alice.retrySend("failed-1");
    } catch {
      // ignore peer-side errors
    }
    await waitFor(() => chatSendsTo("bob").length >= 1);

    const sends = chatSendsTo("bob");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const s of sends) {
      expect(s.notifyPush, "retrySend re-sends text → must remain push-allowed (notifyPush absent)")
        .toBeUndefined();
    }

    await alice.disconnect();
  });
});

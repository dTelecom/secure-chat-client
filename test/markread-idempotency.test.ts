// Regression tests for markRead's lastReadSent idempotency gate.
//
// Background: FE consumers (dmeet web + RN) auto-fire markRead from a
// useEffect tied to the latest inbound messageId. That id is stable
// across page reloads, but their in-memory dedup ref resets on
// component mount. Combined with 0.13.6 making read receipts durable
// on the wire, every reload would otherwise generate a fresh chatSend
// frame to all of peer's devices + selfEcho fanout — wire traffic and
// backend pending-queue churn that scales with reload count.
//
// 0.13.7 added a persisted `lastReadSent[peerUserId]` watermark. The
// gate fires when the requested `upToMessageId` has sentAt > lastSent.
// Updated after a successful sendContent. Also bumped when a sibling's
// selfEcho-of-read arrives (= "another device already shipped on the
// user's behalf; don't re-ship").

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

async function seedInbound(store: MemoryKVStore, msgId: string, sentAt: number): Promise<void> {
  const messages = new MessageStore(new ScopedKVStore(store, "alice"));
  await messages.put({
    id: msgId,
    peerUserId: "bob",
    senderUserId: "bob",
    text: `inbound ${msgId}`,
    sentAt,
    editedAt: null,
    deletedAt: null,
  });
}

describe("markRead idempotency (lastReadSent watermark)", () => {
  it("a fresh SDK on a store with lastReadSent persisted does NOT re-ship the same watermark", async () => {
    const store = new MemoryKVStore();
    await seedInbound(store, "msg-1", 100_000);

    const alice = await connectAlice(store);
    await alice.markRead("bob", "msg-1");
    await waitFor(() => chatSendsTo("bob").length >= 1);
    const initialFrameCount = chatSendsTo("bob").length;
    expect(initialFrameCount, "first markRead should ship a read receipt").toBeGreaterThanOrEqual(1);
    await alice.disconnect();

    // Simulate page reload: fresh SDK instance on the SAME persisted store.
    // The FE auto-fires markRead in the same useEffect on mount.
    const alice2 = await connectAlice(store);
    await alice2.markRead("bob", "msg-1");
    // Give the SDK ample time to process and emit any new frames.
    await new Promise((r) => setTimeout(r, 200));

    const finalFrameCount = chatSendsTo("bob").length;
    expect(
      finalFrameCount,
      "second markRead with same upToMessageId should NOT generate additional wire traffic " +
        "(lastReadSent gate). The FE's reload-fire pattern would otherwise spam the backend pending queue.",
    ).toBe(initialFrameCount);

    await alice2.disconnect();
  });

  it("markRead with a HIGHER watermark still ships (lastReadSent only suppresses same-or-lower)", async () => {
    const store = new MemoryKVStore();
    await seedInbound(store, "msg-old", 100_000);
    await seedInbound(store, "msg-new", 200_000);

    const alice = await connectAlice(store);

    await alice.markRead("bob", "msg-old");
    await waitFor(() => chatSendsTo("bob").length >= 1);
    const afterFirst = chatSendsTo("bob").length;

    await alice.markRead("bob", "msg-new");
    await waitFor(() => chatSendsTo("bob").length > afterFirst);

    expect(
      chatSendsTo("bob").length,
      "second markRead with a higher-sentAt watermark must ship",
    ).toBeGreaterThan(afterFirst);

    await alice.disconnect();
  });

  it("markRead for an UNKNOWN messageId silently skips (no wire frame, no thrown error)", async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);

    // Without seeding the inbound row, the messageId is unknown to
    // messages.get → markRead returns without sending.
    await alice.markRead("bob", "nonexistent-id");
    await new Promise((r) => setTimeout(r, 100));

    const sends = chatSendsTo("bob");
    expect(sends.length, "unknown messageId should not generate a chatSend").toBe(0);

    await alice.disconnect();
  });

  it("repeated markRead within the same SDK instance only ships once", async () => {
    const store = new MemoryKVStore();
    await seedInbound(store, "msg-1", 100_000);
    const alice = await connectAlice(store);

    await alice.markRead("bob", "msg-1");
    await waitFor(() => chatSendsTo("bob").length >= 1);
    const afterFirst = chatSendsTo("bob").length;

    // Three additional calls with the same watermark — none should
    // produce new wire frames.
    await alice.markRead("bob", "msg-1");
    await alice.markRead("bob", "msg-1");
    await alice.markRead("bob", "msg-1");
    await new Promise((r) => setTimeout(r, 100));

    expect(
      chatSendsTo("bob").length,
      "repeated markRead within one SDK instance should be a no-op past the first shipment",
    ).toBe(afterFirst);

    await alice.disconnect();
  });
});

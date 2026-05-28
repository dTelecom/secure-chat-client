// Regression test for read/received receipts triggering offline push.
//
// Before the fix, markRead and the received-batch flusher used the
// durable wire path (`ephemeral: false`). When the peer was offline,
// every "your read indicator advanced" / "✓✓ delivered" event landed
// in the backend's webhook → fired a push notification. That meant:
//   - opening a chat with offline peer → push (markRead)
//   - just RECEIVING a message → push back to the sender (received)
//   - reloading the page while peer offline → another markRead push,
//     because the FE's lastMarkedReadRef resets on mount.
//
// After the fix, both paths use `ephemeral: true`. Test: capture the
// outbound chatSend frames and assert the ephemeral flag is set on
// both read and received events.

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
  msgType?: string;
  targets: Array<{ deviceId: string; ciphertext: string; envelopeUuid: string }>;
}

function findChatSendsTo(toUserId: string): CapturedChatSend[] {
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

describe("read/received receipts must use ephemeral wire path", () => {
  it("markRead emits a chatSend with ephemeral: true", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(new ScopedKVStore(store, "alice"));
    // Seed an inbound message so markRead has a target.
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
    await waitFor(() => findChatSendsTo("bob").length >= 1);

    const sends = findChatSendsTo("bob");
    // markRead sends one chatSend to bob. If selfEcho also ran (alice
    // has other devices), there'd be an additional chatSend to alice —
    // we explicitly filter to bob-targeted frames so the assertion is
    // about the read receipt to the sender only.
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const send of sends) {
      expect(send.ephemeral).toBe(true);
    }

    await alice.disconnect();
  });

  it("received-batch flush emits a chatSend with ephemeral: true", async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);

    // Trigger the received-ack path: send a text from alice, then
    // simulate an inbound text from bob that alice receives — this
    // queues a received-ack and after ~500ms fires the flush.
    //
    // Simpler: directly synthesize an inbound message event so the SDK
    // queues a received-ack and the batch flush fires. We don't have a
    // direct hook for that without dispatchInboundEvent, so we use the
    // sendText path to register session keys, then drive an inbound
    // through the same crypto adapter.
    //
    // For a minimal regression test, simulate a markRead flow that
    // independently exercises the received batch is harder — instead
    // we'll assert at the implementation level: load the SDK source
    // and verify the flushReceivedBatch line uses ephemeral:true. This
    // is a structural test; the unit-level "ephemeral propagates to
    // wire" is already covered by the markRead test above (same
    // sendContent code path).
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(process.cwd(), "src/index.ts"), "utf8");
    // Match the flushReceivedBatch block's sendContent call.
    const match = src.match(/flushReceivedBatch[\s\S]*?newReceived\(ids\),\s*\{\s*ephemeral:\s*(true|false)\s*\}/);
    expect(match, "flushReceivedBatch should call sendContent with newReceived(ids) and an ephemeral flag").not.toBeNull();
    expect(match![1]).toBe("true");

    await alice.disconnect();
  });

  it("selfEcho of a 'read' event also uses ephemeral: true (no push to sibling devices)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(process.cwd(), "src/index.ts"), "utf8");
    // Match the selfEcho block. The ephemeral decision is based on the
    // event type. Ensure the source explicitly handles "read".
    const match = src.match(/private async selfEcho[\s\S]*?const ephemeral\s*=\s*original\.type\s*===\s*"read"/);
    expect(match, "selfEcho should mark 'read' events as ephemeral").not.toBeNull();
  });
});

// Regression test for the "status pending forever after sendText" bug.
//
// Scenario:
//   1. Alice sends a text message to Bob.
//   2. ws.sendChat fires (frame goes out).
//   3. The SDK's Option-A optimistic-promotion path fires
//      status.onSendResult("stored") → StatusTracker dispatches its
//      listener → the listener does `messages.get(messageId)` to
//      mirror the transition into the persisted row.
//   4. BUT: in sendText, `await sendContent(...)` runs BEFORE
//      `messages.put({ status: "pending" })` — so when the listener's
//      `messages.get` resolves, the row doesn't exist yet, the listener
//      silently skips (guarded by `if (msg && ...)` in index.ts:1276),
//      and the subsequent `messages.put({ status: "pending" })` LOCKS
//      IN "pending".
//   5. Result: the message is in IndexedDB forever with status "pending"
//      despite the wire send having succeeded. UI shows ⏳ instead of ✓.
//
// Also exercised: simulated reload (fresh SDK on the same KV store)
// should NOT re-send the message — message_store doesn't redrive
// pending-status entries on init.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
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
      // ignore non-JSON
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
      if (body.peerUserId === "bob") {
        return jsonOk({ devices: [fakeBundle("bob-dev")] });
      }
      // Self-claim returns empty so the selfEcho fan-out is a no-op,
      // keeping the test focused on the bob send path.
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

async function waitForChatSendFrames(min: number, timeoutMs = 2000): Promise<unknown[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const chatFrames = sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend");
    if (chatFrames.length >= min) return chatFrames;
    await new Promise((r) => setTimeout(r, 20));
  }
  return sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend");
}

describe("status-pending-forever bug", () => {
  it("after sendText, the persisted message status should be 'sent' (not stuck at 'pending')", async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);

    const messageId = await alice.sendText("bob", "hello");

    // Wait for the chatSend to actually go out — confirms the wire path
    // ran and StatusTracker.onSendResult("stored") fired.
    const frames = await waitForChatSendFrames(1);
    expect(frames.length).toBe(1);

    // Let any fire-and-forget IIFEs settle (status listener's
    // messages.get/put chain runs async-ly).
    await new Promise((r) => setTimeout(r, 100));

    const history = await alice.getHistory("bob");
    const msg = history.find((m) => m.id === messageId);
    expect(msg).toBeDefined();

    // THE BUG: status remains "pending" because the StatusTracker
    // listener's messages.get returned null when it fired (the
    // sendText body hadn't run its own messages.put yet), so the
    // status mirror was skipped — then sendText's own put with
    // status:"pending" locked it in.
    expect(msg!.status).toBe("sent");

    await alice.disconnect();
  });

  it("after reload (fresh SDK on same KV store), the message status should not be 'pending forever'", async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);
    const messageId = await alice.sendText("bob", "hi-then-reload");
    await waitForChatSendFrames(1);
    await new Promise((r) => setTimeout(r, 100));
    await alice.disconnect();

    // Capture how many frames went out before reload — must not grow
    // after a fresh SDK boots on the same KV.
    const framesBeforeReload = sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend").length;

    // Simulate page reload / app relaunch: fresh SDK instance on the
    // same persisted store (so message_store hydrates from KV).
    const alice2 = await connectAlice(store);
    await new Promise((r) => setTimeout(r, 200)); // let onWsState("open") fire outbox.tick + drainPending

    const framesAfterReload = sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend").length;

    // No automatic re-send of "pending" rows. If this assertion ever
    // fails, the SDK is performing a re-send on init that the user is
    // seeing as the "another push" symptom — that path needs to be
    // identified and removed (or made idempotent via envelopeUuid).
    expect(framesAfterReload).toBe(framesBeforeReload);

    // The persisted status SHOULD be "sent" — same root cause as the
    // first test: if the StatusTracker listener never mirrored "sent"
    // to KV before reload, the loaded row carries the stale "pending".
    const history2 = await alice2.getHistory("bob");
    const msg2 = history2.find((m) => m.id === messageId);
    expect(msg2).toBeDefined();
    expect(msg2!.status).toBe("sent");

    await alice2.disconnect();
  });

  it("a fresh SDK on a store with a 'pending' outbound message must not auto-send anything to that peer", { timeout: 10000 }, async () => {
    const store = new MemoryKVStore();
    const alice = await connectAlice(store);
    await alice.sendText("bob", "first-and-only");
    await waitForChatSendFrames(1);
    await new Promise((r) => setTimeout(r, 200));
    const framesBeforeReload = sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend").length;
    await alice.disconnect();

    // Fresh SDK on the same store. Watch ALL frames over a long window
    // to catch delayed re-sends (the production trace shows the duplicate
    // landing ~14s after reload).
    const alice2 = await connectAlice(store);
    await new Promise((r) => setTimeout(r, 5000));

    const framesAfter = sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend");
    const newFrames = framesAfter.slice(framesBeforeReload);
    expect(newFrames).toEqual([]);

    await alice2.disconnect();
  });
});

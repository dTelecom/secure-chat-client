// Regression test for the multi-device read/received sync bug shipped
// in 0.13.4 and broken-through-0.13.5.
//
// Bug scenario:
//   - User alice has 2 devices: alice-dev1 and alice-dev2.
//   - User bob sends a text to alice → fans out to both devices.
//   - alice-dev1 (live) reads the message and calls `markRead`.
//   - markRead emits a `read` envelope back to bob, AND a selfEcho-of-read
//     to alice's siblings (alice-dev2) so siblings advance their UI to
//     "read" too.
//   - bob is offline. So is alice-dev2.
//   - In 0.13.4–0.13.5, both the bob-bound read and the alice-dev2-bound
//     selfEcho were `ephemeral: true` → one publish attempt, no retry,
//     no webhook fallback → both bob AND alice-dev2 permanently missed
//     the receipts.
//   - alice-dev2 reconnects later → drainPending returns nothing → its
//     UI shows the alice-sent message as "not read by bob" and the
//     bob-sent message as "not read by me" forever.
//
// 0.13.6 fix: read/received/selfEcho all use `ephemeral: false`
// (durable webhook fallback) + `notifyPush: false` (no push). Offline
// targets get the receipt via drainPending on reconnect; the node's
// notifyPush AND-gate suppresses push so durable delivery doesn't mean
// "wake up the offline target".
//
// This test asserts the WIRE-SHAPE contract: when bob calls markRead
// and alice has two devices in her bundle, bob's chatSend frame fans
// out to BOTH alice devices with the durable/silent flag combination.
// The drain-side behavior (alice-dev2's reconnect picks up the queued
// envelope) is exercised by the existing drain-unknown-otk and offline-
// fallback smokes; the regression-prone surface is the wire flags.

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

// makeFetch with multi-device alice. Bob is single-device.
function makeFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") return jsonOk({ ok: true });
    if (u.pathname === "/keys/count") return jsonOk({ count: 100 });
    if (u.pathname === "/keys/claim_all") {
      const body = init?.body ? (JSON.parse(String(init.body)) as { peerUserId?: string }) : {};
      if (body.peerUserId === "alice") {
        // The motivating multi-device case: alice has TWO devices.
        return jsonOk({ devices: [fakeBundle("alice-dev1"), fakeBundle("alice-dev2")] });
      }
      // Bob's self-claim returns empty so bob's selfEcho is a no-op
      // (bob is single-device, his sibling fanout is empty).
      return jsonOk({ devices: [] });
    }
    if (u.pathname === "/envelopes/pending") return jsonOk({ envelopes: [] });
    if (u.pathname === "/envelopes/ack") return jsonOk({ ok: true });
    if (u.pathname === "/keys/list_devices") {
      return jsonOk({
        devices: [
          { deviceId: "alice-dev1", fingerprint: "fp-alice-dev1", lastActiveAt: 0 },
          { deviceId: "alice-dev2", fingerprint: "fp-alice-dev2", lastActiveAt: 0 },
        ],
      });
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

const FAKE_JWT_BOB =
  "header." + btoaUrl(JSON.stringify({ sub: "bob", did: "bob-dev", exp: 9999999999 })) + ".sig";

function btoaUrl(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mintBob(): MintTokenResponse {
  return { chatToken: FAKE_JWT_BOB, expiresAt: 9999999999, chatNodeWsUrl: "wss://fake/chat/ws" };
}

async function connectBob(store: MemoryKVStore): Promise<DTelecomSecureChat> {
  return DTelecomSecureChat.connect({
    apiBaseURL: "http://test",
    selfUserId: "bob",
    fetchChatToken: async () => mintBob(),
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

describe("multi-device receipt sync", () => {
  it("bob's markRead fans out to ALL of alice's devices on a durable, silent wire path", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(new ScopedKVStore(store, "bob"));
    // Seed an inbound message from alice so bob has something to markRead.
    await messages.put({
      id: "alice-msg-1",
      peerUserId: "alice",
      senderUserId: "alice",
      text: "hi bob",
      sentAt: Date.now() - 1000,
      editedAt: null,
      deletedAt: null,
    });

    const bob = await connectBob(store);

    await bob.markRead("alice", "alice-msg-1");
    await waitFor(() => chatSendsTo("alice").length >= 1);

    const sends = chatSendsTo("alice");
    expect(sends.length, "markRead should produce at least one chatSend to alice").toBeGreaterThanOrEqual(1);

    // Collect all targeted alice device IDs across the captured frames.
    // sendContentInner buckets by msgType so a mixed prekey/normal fanout
    // would split into multiple frames; the FakeCryptoAdapter produces a
    // single msgType so we expect one frame with 2 targets, but the test
    // tolerates either layout.
    const allTargets = sends.flatMap((s) => s.targets);
    const targetedDeviceIds = new Set(allTargets.map((t) => t.deviceId));

    expect(
      targetedDeviceIds,
      "read receipt must fan out to BOTH of alice's devices — without this any device offline at markRead time " +
        "permanently misses the receipt (the multi-device sync bug from 0.13.4/0.13.5).",
    ).toEqual(new Set(["alice-dev1", "alice-dev2"]));

    // Every chatSend for read receipts MUST use the durable wire path
    // (ephemeral undefined) so the node falls back to webhook + pending
    // queue for any of alice's devices that aren't currently live.
    for (const send of sends) {
      expect(send.ephemeral, "markRead must use the durable wire path so offline devices drain on reconnect")
        .toBeUndefined();
      expect(send.notifyPush, "markRead must opt out of push via the node-side notifyPush AND-gate")
        .toBe(false);
    }

    await bob.disconnect();
  });

  it("each target envelope has a distinct envelopeUuid (so per-device acks can advance independently)", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(new ScopedKVStore(store, "bob"));
    await messages.put({
      id: "alice-msg-2",
      peerUserId: "alice",
      senderUserId: "alice",
      text: "another",
      sentAt: Date.now() - 1000,
      editedAt: null,
      deletedAt: null,
    });

    const bob = await connectBob(store);

    await bob.markRead("alice", "alice-msg-2");
    await waitFor(() => chatSendsTo("alice").length >= 1);

    const sends = chatSendsTo("alice");
    const allTargets = sends.flatMap((s) => s.targets);
    const uuids = allTargets.map((t) => t.envelopeUuid);
    const uniqueUuids = new Set(uuids);

    expect(uuids.length).toBe(2);
    expect(uniqueUuids.size, "each per-device target needs a unique envelopeUuid").toBe(2);

    await bob.disconnect();
  });
});

// Regression test for the mixed-msgType fanout bug.
//
// `ChatSendFrame.msgType` is frame-level (the wire protocol does not
// carry per-target msgType). When alice's fanout produces a MIX of
// "normal" ciphertext (existing-session devices) and "prekey"
// ciphertext (first-contact devices), the SDK must emit a SEPARATE
// chatSend frame per msgType — otherwise the recipients whose actual
// ciphertext doesn't match the frame-level msgType silently fail to
// decrypt (prekey vs normal have structurally different bytes; vodozemac
// rejects the mismatch).
//
// History: in 0.10.0-pre, src/index.ts unconditionally picked
// `encrypted[0].msgType` and used it for ALL targets in the frame, so
// adding a new peer device after established bidirectional traffic
// broke delivery to the existing-session devices. Caught by the
// multi-device-online-offline smoke and an isolation matrix in
// scripts/debug-reconnect-existing-session.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import type { MintTokenResponse } from "../src/types.js";

const realWebSocket = globalThis.WebSocket;

// Per-test capture of chatSend frames sent via WS.send().
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
      // ignore non-JSON frames
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

// Minimal fake bob device-bundle the mock fetch returns from /keys/claim_all.
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

function makeFetch(bobDevices: string[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") return jsonOk({ ok: true });
    if (u.pathname === "/keys/count") return jsonOk({ count: 100 });
    if (u.pathname === "/keys/claim_all") {
      // Peer-aware: return bob's devices only when claiming "bob".
      // For self-claim ("alice"), return empty so selfEcho fan-out is a
      // no-op — keeps the test focused on the bob fan-out path.
      const body = init?.body ? JSON.parse(String(init.body)) as { peerUserId?: string } : {};
      if (body.peerUserId === "bob") {
        return jsonOk({ devices: bobDevices.map(fakeBundle) });
      }
      return jsonOk({ devices: [] });
    }
    if (u.pathname === "/envelopes/pending") return jsonOk({ envelopes: [] });
    if (u.pathname === "/envelopes/ack") return jsonOk({ ok: true });
    if (u.pathname === "/keys/list_devices") {
      return jsonOk({ devices: bobDevices.map((d) => ({ deviceId: d, fingerprint: `fp-${d}`, lastActiveAt: 0 })) });
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

async function connectAlice(crypto: FakeCryptoAdapter, bobDevices: string[]): Promise<DTelecomSecureChat> {
  const store = new MemoryKVStore();
  return DTelecomSecureChat.connect({
    apiBaseURL: "http://test",
    selfUserId: "alice",
    fetchChatToken: async () => mintAlice(),
    fetchHttpBearer: async () => "fake.bearer",
    store,
    crypto,
    fetchImpl: makeFetch(bobDevices),
  });
}

// Wait until at least one chatSend frame has been sent. Resolves with the
// captured frames so callers can assert on them.
async function waitForFrames(min: number, timeoutMs = 2000): Promise<unknown[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const chatFrames = sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend");
    if (chatFrames.length >= min) return chatFrames;
    await new Promise((r) => setTimeout(r, 20));
  }
  return sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend");
}

describe("mixed-msgType fanout", () => {
  it("uniform fanout (all first-contact) → ONE chatSend frame with msgType=prekey", async () => {
    const crypto = new FakeCryptoAdapter();
    const alice = await connectAlice(crypto, ["bob-A", "bob-B"]);

    await alice.sendText("bob", "first-message");
    const frames = await waitForFrames(1);

    // sendText for a single text event should yield exactly ONE chatSend
    // frame when all targets share msgType.
    expect(frames.length).toBe(1);
    const f = frames[0] as { msgType: string; targets: { deviceId: string }[] };
    expect(f.msgType).toBe("prekey");
    expect(f.targets.map((t) => t.deviceId).sort()).toEqual(["bob-A", "bob-B"]);

    await alice.disconnect();
  });

  it("mixed fanout (existing session + new device) → TWO chatSend frames, one per msgType", async () => {
    // FakeCryptoAdapter tracks established sessions in an in-memory set.
    // First encrypt to a device returns prekey; subsequent returns normal.
    // To set up "existing session for bob-A but not bob-C": warm bob-A
    // via a first send, then later send to [bob-A (cached → normal),
    // bob-C (fresh → prekey)].
    const crypto = new FakeCryptoAdapter();

    // Phase 1: only bob-A registered. Send to warm the session.
    const alice = await connectAlice(crypto, ["bob-A"]);
    await alice.sendText("bob", "warmup");
    await waitForFrames(1);
    // Discard warmup frames; we only want frames from the mixed send.
    sentFrames = [];

    // Phase 2: bob now has TWO devices in claim_all. The HTTP impl is
    // bound at connect time, so to expose the new device-set we reconnect
    // alice using the SAME crypto adapter (so the bob-A session sticks).
    await alice.disconnect();
    const alice2 = await connectAlice(crypto, ["bob-A", "bob-C"]);

    // Force alice2 to do a fresh claim_all for bob (its bundleCache is
    // empty after the new SDK instance). sendText triggers that.
    await alice2.sendText("bob", "mixed-fanout");

    const frames = await waitForFrames(2);
    expect(frames.length).toBe(2);

    // One frame per msgType, each with its own targets subset.
    const byType = new Map<string, { deviceId: string }[]>();
    for (const f of frames) {
      const { msgType, targets } = f as { msgType: string; targets: { deviceId: string }[] };
      byType.set(msgType, targets);
    }
    expect(byType.get("normal")?.map((t) => t.deviceId)).toEqual(["bob-A"]);
    expect(byType.get("prekey")?.map((t) => t.deviceId)).toEqual(["bob-C"]);

    await alice2.disconnect();
  });
});

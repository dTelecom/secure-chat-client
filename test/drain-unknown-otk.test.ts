// 0.13.2 — drainPending acks envelopes that fail decrypt with the
// "unknown one-time key" Olm error. Without this, a permanently-
// undecryptable envelope (e.g., recipient's IndexedDB was wiped after
// the sender claimed the OTK) sits in /envelopes/pending forever, and
// every reconnect produces log spam trying to decrypt it again.
//
// Other decrypt errors (bad MAC, no session, etc.) keep the existing
// "leave on queue, retry next reconnect" behavior — those can recover.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import type { CryptoAdapter, OutboundEnvelope, UploadBundle } from "../src/crypto/interface.js";
import type { ClaimedDevice, MintTokenResponse } from "../src/types.js";

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
function mintAlice(): MintTokenResponse {
  return { chatToken: FAKE_JWT_ALICE, expiresAt: 9999999999, chatNodeWsUrl: "wss://fake/chat/ws" };
}
function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// Test helper: builds a mock fetch that emulates dmeet-backend's
// pending/ack flow. The captured arrays let the test assert what got
// HTTP-acked and how many drain rounds happened.
function makeMockFetch(opts: {
  /** First-call envelopes. Cleared after the first /envelopes/pending hit. */
  initialPending: Array<{
    envelopeUuid: string; senderUserId: string; senderDeviceId: string;
    ciphertext: string; msgType: "prekey" | "normal"; receivedAt: number;
  }>;
  /** Records ack request bodies. */
  ackCalls: string[][];
}): typeof fetch {
  let pendingPool = [...opts.initialPending];
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") return jsonOk({ ok: true });
    if (u.pathname === "/keys/count") return jsonOk({ count: 100 });
    if (u.pathname === "/keys/claim_all") return jsonOk({ devices: [] });
    if (u.pathname === "/envelopes/pending") {
      const out = jsonOk({ envelopes: pendingPool });
      pendingPool = []; // subsequent calls return empty so drainPending stops
      return out;
    }
    if (u.pathname === "/envelopes/ack") {
      const body = init?.body ? JSON.parse(String(init.body)) as { envelopeUuids: string[] } : { envelopeUuids: [] };
      opts.ackCalls.push(body.envelopeUuids);
      return jsonOk({ ok: true });
    }
    return new Response(JSON.stringify({ error: "not_implemented" }), { status: 501 });
  };
}

/** Crypto adapter that throws a chosen error on every decryptFromPeer call. */
class ThrowOnDecryptAdapter implements CryptoAdapter {
  // Delegate encryption side to FakeCryptoAdapter for completeness, but
  // we only exercise the decrypt path here.
  private delegate = new FakeCryptoAdapter();
  constructor(private errMessage: string) {}
  init(): Promise<void> { return this.delegate.init(); }
  hasAccount(): Promise<boolean> { return this.delegate.hasAccount(); }
  generateAccount(n: number): Promise<UploadBundle> { return this.delegate.generateAccount(n); }
  getCurrentBundle(): Promise<UploadBundle> { return this.delegate.getCurrentBundle(); }
  generateOneTimeKeys(n: number): Promise<{ id: string; public: string }[]> {
    return this.delegate.generateOneTimeKeys(n);
  }
  unusedOneTimeKeyCount(): Promise<number> { return this.delegate.unusedOneTimeKeyCount(); }
  encryptForPeer(p: string, d: string, b: ClaimedDevice, plain: string): Promise<OutboundEnvelope> {
    return this.delegate.encryptForPeer(p, d, b, plain);
  }
  async decryptFromPeer(): Promise<string> {
    throw new Error(this.errMessage);
  }
  forgetSession(p: string, d: string): Promise<void> { return this.delegate.forgetSession(p, d); }
  hasSession(p: string, d: string): Promise<boolean> { return this.delegate.hasSession(p, d); }
  clearSessionCache(): void { this.delegate.clearSessionCache(); }
}

async function connectAlice(crypto: CryptoAdapter, fetchImpl: typeof fetch) {
  return DTelecomSecureChat.connect({
    apiBaseURL: "http://test",
    selfUserId: "alice",
    fetchChatToken: async () => mintAlice(),
    fetchHttpBearer: async () => "fake.bearer",
    store: new MemoryKVStore(),
    crypto,
    fetchImpl,
  });
}

const STUCK_ENVELOPE = {
  envelopeUuid: "stuck-uuid-1",
  senderUserId: "bob",
  senderDeviceId: "bob-dev-1",
  ciphertext: "AAAA",
  msgType: "prekey" as const,
  receivedAt: 0,
};

describe("drainPending — terminal vs transient decrypt failures", () => {
  it("'unknown one-time key' → HTTP-acked (clears from backend queue)", async () => {
    const ackCalls: string[][] = [];
    const fetchImpl = makeMockFetch({
      initialPending: [STUCK_ENVELOPE],
      ackCalls,
    });
    const crypto = new ThrowOnDecryptAdapter(
      "The pre-key message contained an unknown one-time key: uoeaKk5hJS3aIcBv/46qP9sAwiWYH2KwYiq32FLYnz8",
    );
    const sdk = await connectAlice(crypto, fetchImpl);

    // Wait for the WS onopen handler to drive drainPending.
    await new Promise((r) => setTimeout(r, 100));

    expect(ackCalls.length).toBe(1);
    expect(ackCalls[0]).toEqual(["stuck-uuid-1"]);

    await sdk.disconnect();
  });

  it("non-terminal decrypt error → NOT acked (stays on queue for retry)", async () => {
    const ackCalls: string[][] = [];
    const fetchImpl = makeMockFetch({
      initialPending: [STUCK_ENVELOPE],
      ackCalls,
    });
    // Anything that doesn't match /unknown one-time key/ is treated
    // as transient.
    const crypto = new ThrowOnDecryptAdapter("OLM_BAD_MESSAGE_MAC");
    const sdk = await connectAlice(crypto, fetchImpl);

    await new Promise((r) => setTimeout(r, 100));

    // Either zero ack calls, or one call with an empty array — the SDK
    // returns from the inner loop without acking if nothing succeeded.
    const totalAcked = ackCalls.flat();
    expect(totalAcked).toEqual([]);

    await sdk.disconnect();
  });

  it("matches the 'unknown one-time key' pattern regardless of exact wording", async () => {
    // Vodozemac's exact message starts with "The pre-key message contained
    // an unknown one-time key:" — but the regex is /unknown one-time key/i
    // so other phrasings of the same condition also match.
    const ackCalls: string[][] = [];
    const fetchImpl = makeMockFetch({
      initialPending: [STUCK_ENVELOPE],
      ackCalls,
    });
    const crypto = new ThrowOnDecryptAdapter("Some other wording: Unknown One-Time Key found");
    const sdk = await connectAlice(crypto, fetchImpl);

    await new Promise((r) => setTimeout(r, 100));

    expect(ackCalls.flat()).toEqual(["stuck-uuid-1"]);

    await sdk.disconnect();
  });
});

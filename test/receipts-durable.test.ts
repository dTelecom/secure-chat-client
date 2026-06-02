// Regression test for read/received receipts using the DURABLE wire path
// with push suppressed via notifyPush.
//
// History of this test:
//   0.13.4: switched read/received to ephemeral:true to suppress push for
//           offline targets. Test asserted ephemeral:true.
//   0.13.5: added the notifyPush wire hint. Receipts kept ephemeral:true
//           "for belt-and-suspenders." Test still asserted ephemeral:true.
//   0.13.6: reverted to ephemeral:false because ephemeral skipped the
//           webhook fallback entirely, so any peer device offline at the
//           moment of the receipt permanently missed the event — the
//           "device 1 shows read, device 2 doesn't" multi-device bug.
//           notifyPush:false handles push suppression on its own.
//
// Current contract: read/received fan out via the DURABLE wire path
// (ephemeral:false) AND mark notifyPush:false. The node ANDs notifyPush
// with its presence-based push decision so the webhook body's
// `push: false` and the backend skips FireChatPushIfNeeded — but the
// envelope is still stored in the recipient's pending queue and drains
// to offline siblings on reconnect.

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

describe("read/received receipts: durable wire path + notifyPush suppression", () => {
  it("markRead emits a chatSend that is durable (no ephemeral flag) and notifyPush:false", async () => {
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
    await waitFor(() => findChatSendsTo("bob").length >= 1);

    const sends = findChatSendsTo("bob");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    for (const send of sends) {
      // ephemeral is wire-emitted only when true (see sendContentInner's
      // `opts.ephemeral || undefined`), so a durable send results in
      // `ephemeral` being undefined on the parsed frame.
      expect(send.ephemeral, "markRead should use durable wire path so offline sibling devices drain on reconnect")
        .toBeUndefined();
      expect(send.notifyPush, "markRead must opt out of push via the node-side hint")
        .toBe(false);
    }

    await alice.disconnect();
  });

  it("flushReceivedBatch source uses { ephemeral: false, notifyPush: false }", async () => {
    // Structural test against the source, because exercising the
    // receive-batch flush end-to-end requires synthesizing an inbound
    // envelope which the FakeCryptoAdapter doesn't expose cleanly.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(process.cwd(), "src/index.ts"), "utf8");

    const match = src.match(
      /flushReceivedBatch[\s\S]*?newReceived\(ids\),\s*\{\s*ephemeral:\s*(true|false),\s*notifyPush:\s*(true|false)\s*\}/,
    );
    expect(
      match,
      "flushReceivedBatch should call sendContent with newReceived(ids) and explicit ephemeral + notifyPush flags",
    ).not.toBeNull();
    expect(match![1], "received receipts must be durable so siblings drain on reconnect").toBe("false");
    expect(match![2], "received receipts must opt out of push").toBe("false");
  });

  it("selfEcho source is durable + notifyPush:false unconditionally (no per-event-type branching)", async () => {
    // Was `const ephemeral = original.type === "read"` in 0.13.5 — that
    // re-introduced the offline-sibling-misses-the-event bug because
    // ephemeral self-echo of read events couldn't reach siblings offline
    // at flush time. Simplified in 0.13.6 to always durable + silent.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(process.cwd(), "src/index.ts"), "utf8");

    // The current selfEcho should issue a single sendContent with
    // explicit { ephemeral: false, notifyPush: false }.
    const match = src.match(
      /private async selfEcho[\s\S]*?sendContent\(\s*this\.selfUserId,\s*echo,\s*\{\s*ephemeral:\s*false,\s*notifyPush:\s*false\s*\}/,
    );
    expect(
      match,
      "selfEcho should call sendContent(self, echo, { ephemeral: false, notifyPush: false })",
    ).not.toBeNull();

    // Defensive: the old conditional `const ephemeral = original.type === "read"`
    // must NOT be in the file anymore.
    expect(
      src.includes("const ephemeral = original.type === \"read\""),
      "selfEcho no longer ephemeralizes 'read' events — see multi-device-receipt-sync test for the reproduction",
    ).toBe(false);
  });
});

// Chat-delete: delete-for-me + delete-for-everyone + watermark replay guard.
// Uses the FakeCryptoAdapter so we can introspect outgoing content events
// directly (FakeCryptoAdapter encrypts as base64(MARKER+plaintext)). The
// WS is mocked to just collect outbound frames.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MessageStore } from "../src/message_store.js";
import { ConversationIndex } from "../src/conversations.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import { ScopedKVStore } from "../src/store/scoped-adapter.js";
import type { MintTokenResponse, ChatSendFrame } from "../src/types.js";

const realWebSocket = globalThis.WebSocket;

// Capture outbound frames so we can assert sender behavior.
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
    try { sentFrames.push(JSON.parse(data)); } catch {}
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

const FAKE_JWT_ALICE =
  "header." + btoaUrl(JSON.stringify({ sub: "alice", did: "alice-dev", exp: 9999999999 })) + ".sig";
function btoaUrl(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

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
      const body = init?.body ? JSON.parse(String(init.body)) as { peerUserId?: string } : {};
      if (body.peerUserId === "bob") return jsonOk({ devices: bobDevices.map(fakeBundle) });
      return jsonOk({ devices: [] });
    }
    if (u.pathname === "/envelopes/pending") return jsonOk({ envelopes: [] });
    if (u.pathname === "/envelopes/ack") return jsonOk({ ok: true });
    if (u.pathname === "/keys/list_devices") return jsonOk({ devices: [] });
    return new Response(JSON.stringify({ error: "not_implemented" }), { status: 501 });
  };
}

function mintAlice(): MintTokenResponse {
  return { chatToken: FAKE_JWT_ALICE, expiresAt: 9999999999, chatNodeWsUrl: "wss://fake/chat/ws" };
}

async function connectAlice(
  store: MemoryKVStore,
  bobDevices: string[] = ["bob-dev-1"],
): Promise<DTelecomSecureChat> {
  return DTelecomSecureChat.connect({
    apiBaseURL: "http://test",
    selfUserId: "alice",
    fetchChatToken: async () => mintAlice(),
    fetchHttpBearer: async () => "fake.bearer",
    store,
    crypto: new FakeCryptoAdapter(),
    fetchImpl: makeFetch(bobDevices),
  });
}

const scopedAlice = (kv: MemoryKVStore) => new ScopedKVStore(kv, "alice");

function chatSendFrames(): ChatSendFrame[] {
  return sentFrames.filter((f) => (f as { kind?: string }).kind === "chatSend") as ChatSendFrame[];
}

// Decode a FakeCryptoAdapter-encrypted ciphertext back to the event JSON.
// FakeCryptoAdapter encodes as base64(MARKER + plaintext); the prefix is
// either "FAKEPREKEY:" or "FAKENORMAL:" — strip and parse.
function decodeFakeCiphertext(ct: string): unknown {
  const raw = atob(ct);
  const colon = raw.indexOf(":");
  const plaintext = colon >= 0 ? raw.slice(colon + 1) : raw;
  return JSON.parse(plaintext);
}

describe("deleteConversationForMe", () => {
  it("wipes local messages + index row, bumps watermark, fires events", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    const conversations = new ConversationIndex(scopedAlice(store), messages, () => "alice");
    await messages.put({
      id: "m1", peerUserId: "bob", senderUserId: "bob", text: "hi",
      sentAt: 1_000, editedAt: null, deletedAt: null,
    });
    await conversations.onMessageStored({
      peerUserId: "bob", senderUserId: "bob", messageId: "m1", sentAt: 1_000,
    });

    const sdk = await connectAlice(store);
    const events: { peerUserId: string; scope: "me" | "everyone" }[] = [];
    sdk.on("conversationDeletedBySelf", (e) => events.push(e));

    const beforeWatermark = await messages.getDeleteWatermark("bob");
    expect(beforeWatermark).toBe(0);

    await sdk.deleteConversationForMe("bob");

    const after = await sdk.getHistory("bob");
    expect(after.length).toBe(0);
    const convs = await sdk.listConversations();
    expect(convs.find((c) => c.peerUserId === "bob")).toBeUndefined();
    const wm = await messages.getDeleteWatermark("bob");
    expect(wm).toBeGreaterThan(0);
    expect(events).toEqual([{ peerUserId: "bob", scope: "me" }]);

    await sdk.disconnect();
  });
});

describe("deleteConversationForEveryone", () => {
  it("sends chatDeleteAll to peer, wipes local, bumps watermark, fires events", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.put({
      id: "m1", peerUserId: "bob", senderUserId: "alice", text: "hello",
      sentAt: 1_000, editedAt: null, deletedAt: null,
    });

    const sdk = await connectAlice(store);
    const events: { peerUserId: string; scope: "me" | "everyone" }[] = [];
    sdk.on("conversationDeletedBySelf", (e) => events.push(e));

    await sdk.deleteConversationForEveryone("bob");

    // Local wiped.
    expect((await sdk.getHistory("bob")).length).toBe(0);
    expect(await messages.getDeleteWatermark("bob")).toBeGreaterThan(0);
    expect(events.find((e) => e.scope === "everyone")).toBeTruthy();

    // chatSend frame: at least one was fired targeting bob with a
    // chatDeleteAll event. Decode the ciphertext to verify.
    const frames = chatSendFrames();
    const toBob = frames.find((f) => f.toUserId === "bob");
    expect(toBob).toBeTruthy();
    expect(toBob!.targets.length).toBeGreaterThanOrEqual(1);
    const decoded = decodeFakeCiphertext(toBob!.targets[0].ciphertext) as { type: string };
    expect(decoded.type).toBe("chatDeleteAll");

    await sdk.disconnect();
  });
});

describe("chatDeleteAll receiver — one-shot watermark guard", () => {
  it("honors a delete-all whose clientSentAt > watermark", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.put({
      id: "m1", peerUserId: "bob", senderUserId: "bob", text: "from bob",
      sentAt: 1_000, editedAt: null, deletedAt: null,
    });

    const sdk = await connectAlice(store);
    const events: { peerUserId: string }[] = [];
    sdk.on("conversationDeletedByPeer", (e) => events.push(e));

    // Inject a synthetic chatDeleteAll directly via the receive pipeline
    // — much simpler than going through a real Olm session. We access
    // the dispatcher through a private cast.
    const dispatchInbound = (sdk as unknown as {
      dispatchInboundEvent(peer: string, dev: string, evt: unknown): Promise<void>;
    }).dispatchInboundEvent;
    await dispatchInbound.call(sdk, "bob", "bob-dev-1", {
      v: 1, id: "e1", type: "chatDeleteAll", clientSentAt: 5_000,
    });

    expect((await sdk.getHistory("bob")).length).toBe(0);
    expect(await messages.getDeleteWatermark("bob")).toBe(5_000);
    expect(events).toEqual([{ peerUserId: "bob" }]);

    await sdk.disconnect();
  });

  it("drops a delete-all whose clientSentAt <= watermark (replay guard)", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.put({
      id: "m1", peerUserId: "bob", senderUserId: "bob", text: "from bob",
      sentAt: 10_000, editedAt: null, deletedAt: null,
    });
    // Watermark already at 9_000 (e.g., a prior delete-all was honored
    // OR we re-engaged via sendText recently).
    await messages.setDeleteWatermark("bob", 9_000);

    const sdk = await connectAlice(store);
    const events: { peerUserId: string }[] = [];
    sdk.on("conversationDeletedByPeer", (e) => events.push(e));

    const dispatchInbound = (sdk as unknown as {
      dispatchInboundEvent(peer: string, dev: string, evt: unknown): Promise<void>;
    }).dispatchInboundEvent;
    // Replay a stale delete-all with an OLDER clientSentAt.
    await dispatchInbound.call(sdk, "bob", "bob-dev-1", {
      v: 1, id: "stale", type: "chatDeleteAll", clientSentAt: 8_500,
    });

    // History intact, event NOT fired.
    expect((await sdk.getHistory("bob")).length).toBe(1);
    expect(await messages.getDeleteWatermark("bob")).toBe(9_000);
    expect(events.length).toBe(0);

    await sdk.disconnect();
  });

  it("equal clientSentAt is rejected (treated as stale)", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.setDeleteWatermark("bob", 7_777);
    await messages.put({
      id: "m1", peerUserId: "bob", senderUserId: "bob", text: "x",
      sentAt: 7_500, editedAt: null, deletedAt: null,
    });

    const sdk = await connectAlice(store);
    const dispatchInbound = (sdk as unknown as {
      dispatchInboundEvent(peer: string, dev: string, evt: unknown): Promise<void>;
    }).dispatchInboundEvent;
    await dispatchInbound.call(sdk, "bob", "bob-dev-1", {
      v: 1, id: "dup", type: "chatDeleteAll", clientSentAt: 7_777,
    });

    expect((await sdk.getHistory("bob")).length).toBe(1);
    await sdk.disconnect();
  });
});

describe("re-engagement bumps watermark", () => {
  it("inbound text from peer past a prior delete bumps watermark to the text's clientSentAt", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.setDeleteWatermark("bob", 1_000);

    const sdk = await connectAlice(store);
    const dispatchInbound = (sdk as unknown as {
      dispatchInboundEvent(peer: string, dev: string, evt: unknown): Promise<void>;
    }).dispatchInboundEvent;

    await dispatchInbound.call(sdk, "bob", "bob-dev-1", {
      v: 1, id: "t1", type: "text", clientSentAt: 5_000, text: "still here",
    });

    expect(await messages.getDeleteWatermark("bob")).toBe(5_000);
    // ... and a stale delete-all at 4_500 is now blocked:
    await dispatchInbound.call(sdk, "bob", "bob-dev-1", {
      v: 1, id: "old-delete", type: "chatDeleteAll", clientSentAt: 4_500,
    });
    expect((await sdk.getHistory("bob")).length).toBe(1);

    await sdk.disconnect();
  });

  it("inbound text does not lower a higher watermark", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.setDeleteWatermark("bob", 10_000);

    const sdk = await connectAlice(store);
    const dispatchInbound = (sdk as unknown as {
      dispatchInboundEvent(peer: string, dev: string, evt: unknown): Promise<void>;
    }).dispatchInboundEvent;
    await dispatchInbound.call(sdk, "bob", "bob-dev-1", {
      v: 1, id: "t1", type: "text", clientSentAt: 8_000, text: "racy",
    });
    expect(await messages.getDeleteWatermark("bob")).toBe(10_000);

    await sdk.disconnect();
  });
});

describe("peer-authored chatDeleteSelf is rejected", () => {
  it("a peer attempting chatDeleteSelf cannot wipe our local state", async () => {
    const store = new MemoryKVStore();
    const messages = new MessageStore(scopedAlice(store));
    await messages.put({
      id: "m1", peerUserId: "bob", senderUserId: "bob", text: "should survive",
      sentAt: 1_000, editedAt: null, deletedAt: null,
    });

    const sdk = await connectAlice(store);
    const dispatchInbound = (sdk as unknown as {
      dispatchInboundEvent(peer: string, dev: string, evt: unknown): Promise<void>;
    }).dispatchInboundEvent;
    // Even if bob sends a chatDeleteSelf naming an arbitrary peerUserId,
    // it should be dropped — chatDeleteSelf is sibling-only by design.
    await dispatchInbound.call(sdk, "bob", "bob-dev-1", {
      v: 1, id: "bad", type: "chatDeleteSelf", clientSentAt: 5_000, peerUserId: "carol",
    });
    expect((await sdk.getHistory("bob")).length).toBe(1);

    await sdk.disconnect();
  });
});

// Regression guard for the multi-device sender status sync bug fixed
// 2026-06-02. See `dispatchInboundEvent`'s selfEcho `case "text":` for
// the fix: it now persists status:"pending" as a baseline AND calls
// `status.trackOutbound(...)` so subsequent peer received/read events
// advance the row's status and the StatusTracker listener mirrors it
// into message_store.
//
// Original scenario reported by the user:
//   - Alice opens chat in two browser windows: A_dev1 and A_dev2.
//   - A_dev1 sends a text message to bob. A_dev2 receives the selfEcho
//     fanout, so its message list shows the message too.
//   - Bob reads the message on his device. Bob's SDK emits `received`
//     and `read` events that fan out to ALL of alice's devices.
//   - Both A_dev1 and A_dev2 receive bob's status events.
//   - Real-time: both browsers show the correct ✓✓ status because the
//     FE renders status from React state populated by readReceipt and
//     statusChange events.
//   - Both browsers reload. Before the fix, A_dev1 still showed ✓✓ but
//     A_dev2 reverted to single ✓ "sent" — the status seen in real-time
//     was never persisted to message_store on the sibling, because the
//     selfEcho text handler didn't register the message with the
//     StatusTracker → peer events found no outbound entry → silent
//     no-op → mirror-into-message_store listener never fired → row in
//     store kept `status === undefined` → on reload MessageBubble
//     rendered (status ?? "sent") → single check mark.
//
// The test injects events via `dispatchInboundEvent` (private — cast
// to any) to keep the reproduction self-contained.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import type { MintTokenResponse } from "../src/types.js";

const realWebSocket = globalThis.WebSocket;

class CapturingWs {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send(_data: string): void {
    // No-op: the test injects inbound events directly via
    // dispatchInboundEvent. We don't need to capture wire output.
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
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    CapturingWs as unknown as typeof WebSocket;
});
afterEach(() => {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = realWebSocket;
});

// makeFetch returns a fetch mock parameterized by bob's device list.
// The sibling-tracking fix calls /keys/list_devices(originalPeer) to
// populate the outbound peerDevices set for the StatusTracker, so the
// number of bob devices controls the delivered → deliveredAll
// transition (1-of-1 → deliveredAll; 1-of-2 → delivered).
function makeFetch(bobDeviceIds: readonly string[] = ["bob-dev"]): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") return jsonOk({ ok: true });
    if (u.pathname === "/keys/count") return jsonOk({ count: 100 });
    if (u.pathname === "/keys/claim_all") return jsonOk({ devices: [] });
    if (u.pathname === "/envelopes/pending") return jsonOk({ envelopes: [] });
    if (u.pathname === "/envelopes/ack") return jsonOk({ ok: true });
    if (u.pathname === "/keys/list_devices") {
      return jsonOk({
        devices: bobDeviceIds.map((d) => ({ deviceId: d, fingerprint: `fp-${d}`, lastActiveAt: 0 })),
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

const FAKE_JWT_ALICE =
  "header." + btoaUrl(JSON.stringify({ sub: "alice", did: "alice-dev2", exp: 9999999999 })) + ".sig";

function btoaUrl(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mintAlice(): MintTokenResponse {
  return { chatToken: FAKE_JWT_ALICE, expiresAt: 9999999999, chatNodeWsUrl: "wss://fake/chat/ws" };
}

// connectAliceSibling represents A_dev2 in the scenario — the device
// that is NOT the originating sender.
async function connectAliceSibling(
  store: MemoryKVStore,
  bobDeviceIds: readonly string[] = ["bob-dev"],
): Promise<DTelecomSecureChat> {
  return DTelecomSecureChat.connect({
    apiBaseURL: "http://test",
    selfUserId: "alice",
    fetchChatToken: async () => mintAlice(),
    fetchHttpBearer: async () => "fake.bearer",
    store,
    crypto: new FakeCryptoAdapter(),
    fetchImpl: makeFetch(bobDeviceIds),
  });
}

describe("multi-device sender status sync (sibling browser)", () => {
  it("sibling persists status:'deliveredAll' after selfEcho + bob's received event (bob has 1 device)", async () => {
    const store = new MemoryKVStore();
    const sibling = await connectAliceSibling(store);
    const internals = sibling as unknown as {
      dispatchInboundEvent: (
        peerUserId: string,
        peerDeviceId: string,
        event: unknown,
      ) => Promise<void>;
    };

    const messageId = "msg-from-other-device-1";
    const sentAt = Date.now() - 5000;

    // Step 1: A_dev1 sent a text to bob. A_dev2 (this SDK) receives the
    // selfEcho fanout. Simulate by directly invoking the inbound handler
    // with a selfEcho-wrapped text event coming from "alice / alice-dev1".
    await internals.dispatchInboundEvent("alice", "alice-dev1", {
      v: 1,
      type: "selfEcho",
      id: "selfecho-envelope-1",
      clientSentAt: sentAt,
      originalPeer: "bob",
      original: {
        v: 1,
        type: "text",
        id: messageId,
        clientSentAt: sentAt,
        text: "hi bob from dev1",
      },
    });

    // Sanity: the message exists in the local store after selfEcho,
    // with a baseline status of "pending" (set by the fix so the FE
    // has a stable indicator to render before any peer events arrive).
    const history1 = await sibling.getHistory("bob");
    const stored1 = history1.find((m) => m.id === messageId);
    expect(stored1, "selfEcho should land the message in A_dev2's store").toBeDefined();
    expect(stored1!.senderUserId).toBe("alice");
    expect(
      stored1!.status,
      "sibling persists the row with status:'pending' so the FE renders a stable baseline",
    ).toBe("pending");

    // Step 2: bob's device received the message and fired a `received`
    // event back to alice. The fanout reaches BOTH alice devices.
    // Inject the received event into A_dev2.
    await internals.dispatchInboundEvent("bob", "bob-dev", {
      v: 1,
      type: "received",
      id: "received-envelope-1",
      clientSentAt: Date.now(),
      ids: [messageId],
    });
    // Let any fire-and-forget IIFEs (the StatusTracker listener that
    // mirrors transitions into message_store) settle.
    await new Promise((r) => setTimeout(r, 100));

    // Step 3: bob has one device (per the mocked /keys/list_devices),
    // so the single received event covers his entire device set →
    // status advances to "deliveredAll" and is persisted into
    // message_store via the StatusTracker listener. After reload the
    // FE would render the correct ✓✓.
    const history2 = await sibling.getHistory("bob");
    const stored2 = history2.find((m) => m.id === messageId);
    expect(stored2).toBeDefined();
    expect(
      stored2!.status,
      "bob has one device → his single received envelope covers the full peerDevices set, so " +
        "status advances all the way to 'deliveredAll' on the sibling, mirroring the sender's path.",
    ).toBe("deliveredAll");

    await sibling.disconnect();
  });

  it("sibling persists status:'read' after bob's `read` watermark advances past the message", async () => {
    const store = new MemoryKVStore();
    const sibling = await connectAliceSibling(store);
    const internals = sibling as unknown as {
      dispatchInboundEvent: (
        peerUserId: string,
        peerDeviceId: string,
        event: unknown,
      ) => Promise<void>;
    };

    const messageId = "msg-from-other-device-2";
    const sentAt = Date.now() - 5000;

    // selfEcho text arrives on A_dev2.
    await internals.dispatchInboundEvent("alice", "alice-dev1", {
      v: 1,
      type: "selfEcho",
      id: "selfecho-envelope-2",
      clientSentAt: sentAt,
      originalPeer: "bob",
      original: {
        v: 1,
        type: "text",
        id: messageId,
        clientSentAt: sentAt,
        text: "yet another",
      },
    });

    // bob's read watermark advances to this message.
    await internals.dispatchInboundEvent("bob", "bob-dev", {
      v: 1,
      type: "read",
      id: "read-envelope-1",
      clientSentAt: Date.now(),
      upToId: messageId,
    });
    await new Promise((r) => setTimeout(r, 100));

    const history = await sibling.getHistory("bob");
    const stored = history.find((m) => m.id === messageId);
    expect(stored).toBeDefined();
    expect(
      stored!.status,
      "selfEcho text handler called trackOutbound → byPeer['bob'] is populated → onRead finds " +
        "this messageId at the upToId boundary → bumps to 'read' → listener mirrors into store.",
    ).toBe("read");

    await sibling.disconnect();
  });

  it("multi-device bob: sibling shows 'delivered' after first device acks, advances to 'deliveredAll' after second", async () => {
    // The interesting case — bob has 2 devices, so the StatusTracker
    // must distinguish "one of two confirmed" (delivered) from "both
    // confirmed" (deliveredAll). The sibling fix populates the
    // outbound entry's peerDevices from /keys/list_devices(bob), so
    // this distinction holds on the sibling exactly like on the sender.
    const store = new MemoryKVStore();
    const sibling = await connectAliceSibling(store, ["bob-dev1", "bob-dev2"]);
    const internals = sibling as unknown as {
      dispatchInboundEvent: (
        peerUserId: string,
        peerDeviceId: string,
        event: unknown,
      ) => Promise<void>;
    };

    const messageId = "msg-multidev-bob";
    const sentAt = Date.now() - 5000;

    // selfEcho text arrives on A_dev2.
    await internals.dispatchInboundEvent("alice", "alice-dev1", {
      v: 1,
      type: "selfEcho",
      id: "selfecho-envelope-multidev",
      clientSentAt: sentAt,
      originalPeer: "bob",
      original: {
        v: 1,
        type: "text",
        id: messageId,
        clientSentAt: sentAt,
        text: "to multi-device bob",
      },
    });

    // Only bob's first device acks.
    await internals.dispatchInboundEvent("bob", "bob-dev1", {
      v: 1,
      type: "received",
      id: "received-envelope-bobdev1",
      clientSentAt: Date.now(),
      ids: [messageId],
    });
    await new Promise((r) => setTimeout(r, 100));

    let stored = (await sibling.getHistory("bob")).find((m) => m.id === messageId);
    expect(stored?.status, "one of two bob devices acked → status should be 'delivered', NOT 'deliveredAll'").toBe("delivered");

    // Bob's second device acks.
    await internals.dispatchInboundEvent("bob", "bob-dev2", {
      v: 1,
      type: "received",
      id: "received-envelope-bobdev2",
      clientSentAt: Date.now(),
      ids: [messageId],
    });
    await new Promise((r) => setTimeout(r, 100));

    stored = (await sibling.getHistory("bob")).find((m) => m.id === messageId);
    expect(stored?.status, "both bob devices acked → status should advance to 'deliveredAll'").toBe("deliveredAll");

    await sibling.disconnect();
  });

  it("peer's `read` event arrives BEFORE the selfEcho text — sibling still ends at 'read' (race fix)", async () => {
    // Production failure pattern reproduced exactly from the user's
    // log on 2026-06-02:
    //   readReceipt at 35.508 — peer's read event arrived
    //   message at 35.555 — selfEcho text arrived (registers trackOutbound)
    //   statusChange "delivered" at 35.982 — late received event bumped
    //                                         status but the earlier read
    //                                         was already lost.
    // After the StatusTracker buffer fix, the buffered read replays on
    // trackOutbound and the sibling correctly persists "read".
    const store = new MemoryKVStore();
    const sibling = await connectAliceSibling(store);
    const internals = sibling as unknown as {
      dispatchInboundEvent: (
        peerUserId: string,
        peerDeviceId: string,
        event: unknown,
      ) => Promise<void>;
    };

    const messageId = "msg-race-fix";
    const sentAt = Date.now() - 5000;

    // STEP 1 (was lost without the fix): peer's `read` event arrives
    // FIRST. The sibling has no outbound entry for messageId yet.
    await internals.dispatchInboundEvent("bob", "bob-dev", {
      v: 1,
      type: "read",
      id: "read-envelope-race",
      clientSentAt: Date.now(),
      upToId: messageId,
    });
    await new Promise((r) => setTimeout(r, 50));

    // STEP 2: selfEcho text arrives, triggering trackOutbound and the
    // buffer replay. The replayed onRead now finds messageId in
    // byPeer["bob"] and bumps to "read".
    await internals.dispatchInboundEvent("alice", "alice-dev1", {
      v: 1,
      type: "selfEcho",
      id: "selfecho-envelope-race",
      clientSentAt: sentAt,
      originalPeer: "bob",
      original: {
        v: 1,
        type: "text",
        id: messageId,
        clientSentAt: sentAt,
        text: "the race-fix message",
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    const stored = (await sibling.getHistory("bob")).find((m) => m.id === messageId);
    expect(stored, "selfEcho should land the message").toBeDefined();
    expect(
      stored!.status,
      "Even though peer's read arrived BEFORE the selfEcho text, the buffer-replay path in " +
        "trackOutbound advances status all the way to 'read'. Without the fix this would stay " +
        "at 'pending' (or 'delivered' if a received also came in late) and the FE would render " +
        "the wrong status on reload.",
    ).toBe("read");

    await sibling.disconnect();
  });

  it("status persists across SDK reload (the load-bearing user-visible guarantee)", async () => {
    // The original bug symptom — the FE shows the right status in
    // real-time but a page reload reverts it. After the fix the
    // status is persisted into message_store, so a fresh SDK
    // instance on the same KV store reads it back.
    const store = new MemoryKVStore();
    {
      const sibling = await connectAliceSibling(store);
      const internals = sibling as unknown as {
        dispatchInboundEvent: (
          peerUserId: string,
          peerDeviceId: string,
          event: unknown,
        ) => Promise<void>;
      };

      const sentAt = Date.now() - 5000;
      await internals.dispatchInboundEvent("alice", "alice-dev1", {
        v: 1,
        type: "selfEcho",
        id: "selfecho-reload",
        clientSentAt: sentAt,
        originalPeer: "bob",
        original: {
          v: 1,
          type: "text",
          id: "msg-reload",
          clientSentAt: sentAt,
          text: "reload me",
        },
      });
      await internals.dispatchInboundEvent("bob", "bob-dev", {
        v: 1,
        type: "read",
        id: "read-envelope-reload",
        clientSentAt: Date.now(),
        upToId: "msg-reload",
      });
      await new Promise((r) => setTimeout(r, 100));
      await sibling.disconnect();
    }

    // Simulate page reload: fresh SDK instance on the same store.
    const reloaded = await connectAliceSibling(store);
    const history = await reloaded.getHistory("bob");
    const persisted = history.find((m) => m.id === "msg-reload");
    expect(persisted, "selfEcho message survives reload").toBeDefined();
    expect(
      persisted!.status,
      "status persisted into message_store survives reload → FE no longer reverts to single ✓",
    ).toBe("read");

    await reloaded.disconnect();
  });
});

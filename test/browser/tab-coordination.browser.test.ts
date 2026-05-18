// Browser-mode smoke: two SDK instances in the SAME page acquire the
// real `navigator.locks` API to coordinate "primary tab" status. The
// Web Locks API is origin-scoped, so two requests with the same name
// in one page behave the same as two tabs of the same origin —
// adequate for exercising the SDK's lock state machine end-to-end
// without spinning up a real second tab.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../../src/index.js";
import { FakeCryptoAdapter } from "../../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../../src/store/memory-adapter.js";
import type { MintTokenResponse } from "../../src/types.js";

// A no-op WebSocket stub so the SDK's `ws.connect()` resolves without
// trying to reach a real chat node. We're testing the lock-coordination
// state machine, not the WS layer.
class StubWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }, 0);
  }
  send(_: string): void {
    /* no-op */
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}
let realWS: typeof WebSocket;
beforeAll(() => {
  realWS = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket;
});
afterAll(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWS;
});

const FAKE_JWT_ALICE =
  "header." + btoaUrl(JSON.stringify({ sub: "alice", did: "alice-dev", exp: 9999999999 })) + ".sig";

function btoaUrl(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function mintAlice(): MintTokenResponse {
  return {
    chatToken: FAKE_JWT_ALICE,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    chatNodeWsUrl: "wss://does-not-matter.test",
  };
}

function makeMockFetch(): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname === "/keys/count") {
      return new Response(JSON.stringify({ count: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not_implemented", path: u.pathname }), {
      status: 501,
      headers: { "content-type": "application/json" },
    });
  };
}

async function connectAlice(store: MemoryKVStore = new MemoryKVStore()): Promise<DTelecomSecureChat> {
  // Tag apiBaseURL with a random suffix per test run so different test
  // cases don't collide on the same Web Locks lock name across reruns.
  const suffix = Math.random().toString(36).slice(2, 8);
  return DTelecomSecureChat.connect({
    apiBaseURL: `http://test-${suffix}`,
    selfUserId: "alice",
    fetchChatToken: async () => mintAlice(),
    fetchHttpBearer: async () => "fake.bearer",
    store,
    crypto: new FakeCryptoAdapter(),
    fetchImpl: makeMockFetch(),
  });
}

describe("tab-coordination in a real browser", () => {
  it("first instance is primary, second is secondary, takeOver flips both", async () => {
    // Tag apiBaseURL via a single suffix so BOTH instances target the
    // same lock — that's what makes the second instance go secondary.
    const suffix = `same-${Math.random().toString(36).slice(2, 8)}`;
    const baseURL = `http://test-${suffix}`;
    const connectOpts = (store: MemoryKVStore) => ({
      apiBaseURL: baseURL,
      selfUserId: "alice",
      fetchChatToken: async () => mintAlice(),
      fetchHttpBearer: async () => "fake.bearer",
      store,
      crypto: new FakeCryptoAdapter(),
      fetchImpl: makeMockFetch(),
    });

    const sdk1 = await DTelecomSecureChat.connect(connectOpts(new MemoryKVStore()));
    expect(sdk1.isPrimary()).toBe(true);

    const sdk2 = await DTelecomSecureChat.connect(connectOpts(new MemoryKVStore()));
    // sdk2 hits the lock-already-held branch → secondary.
    expect(sdk2.isPrimary()).toBe(false);

    // Wire a listener on sdk1 BEFORE takeOver so we capture the
    // demotion event.
    let sdk1Demoted = false;
    sdk1.on("tabConflict", (e) => {
      if (e.role === "secondary") sdk1Demoted = true;
    });

    await sdk2.takeOver();
    expect(sdk2.isPrimary()).toBe(true);

    // Yield to give the lock-rejection on sdk1 a chance to dispatch.
    await new Promise((r) => setTimeout(r, 50));
    expect(sdk1Demoted).toBe(true);
    expect(sdk1.isPrimary()).toBe(false);

    await sdk2.disconnect();
    await sdk1.disconnect();
  });

  it("solo instance with no contention starts primary", async () => {
    const sdk = await connectAlice();
    expect(sdk.isPrimary()).toBe(true);
    await sdk.disconnect();
  });
});

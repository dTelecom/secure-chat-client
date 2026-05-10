// Tests for sessions.ts + key_bundle.ts + device_discovery.ts using the
// FakeCryptoAdapter — exercises the whole orchestration layer without WASM.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { KeyBundleManager } from "../src/key_bundle.js";
import { PeerDeviceCache } from "../src/device_discovery.js";
import { SessionManager } from "../src/sessions.js";
import type { ClaimedDevice, MintTokenResponse } from "../src/types.js";
import { HttpClient } from "../src/transport/http.js";

const FAKE_JWT = "header.body.sig";

function fakeMint(): MintTokenResponse {
  return {
    chatToken: FAKE_JWT,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    chatNodeWsUrl: "wss://node.test/chat/ws",
  };
}

function makeFetch(handlers: Record<string, (req: Request) => Response | Promise<Response>>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const h = handlers[key];
    if (!h) {
      return new Response(JSON.stringify({ error: "not_implemented", key }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }
    return h(req);
  };
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeBundle(deviceId: string, otkPresent = true): ClaimedDevice {
  return {
    deviceId,
    identityKeyCurve: "IK_C",
    identityKeyEd: "IK_E",
    signedPrekey: "SP",
    signedPrekeySig: "SPS",
    oneTimeKey: otkPresent ? { id: `${deviceId}-otk-1`, public: "OTK" } : null,
    fallbackPrekey: "FB",
    fallbackPrekeySig: "FBS",
    fingerprint: "FP",
    lastActiveAt: 1000,
  };
}

// ── KeyBundleManager ─────────────────────────────────────────────────────────

describe("KeyBundleManager", () => {
  let crypto: FakeCryptoAdapter;
  let httpCalls: Array<{ method: string; path: string; body?: unknown }>;

  beforeEach(() => {
    crypto = new FakeCryptoAdapter();
    httpCalls = [];
  });

  function makeHttp(otkCount: number) {
    return new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchImpl: makeFetch({
        "POST /api/chat/keys/upload": async (req) => {
          httpCalls.push({ method: req.method, path: "/api/chat/keys/upload", body: await req.json() });
          return jsonOk({ ok: true });
        },
        "POST /api/chat/keys/topup": async (req) => {
          httpCalls.push({ method: req.method, path: "/api/chat/keys/topup", body: await req.json() });
          return jsonOk({ ok: true, currentCount: 100 });
        },
        "GET /api/chat/keys/count": async () => {
          httpCalls.push({ method: "GET", path: "/api/chat/keys/count" });
          return jsonOk({ count: otkCount });
        },
      }),
    });
  }

  it("first-run ensureKeyBundle generates account + uploads", async () => {
    const http = makeHttp(100);
    const mgr = new KeyBundleManager({ http, crypto, deviceId: "dev1" });
    await mgr.ensureKeyBundle();
    expect(await crypto.hasAccount()).toBe(true);
    expect(httpCalls).toHaveLength(1);
    expect(httpCalls[0].path).toBe("/api/chat/keys/upload");
    const body = httpCalls[0].body as { deviceId: string; oneTimeKeys: unknown[] };
    expect(body.deviceId).toBe("dev1");
    expect(body.oneTimeKeys).toHaveLength(100);
  });

  it("ensureKeyBundle is a no-op on subsequent calls (account already exists)", async () => {
    const http = makeHttp(100);
    const mgr = new KeyBundleManager({ http, crypto, deviceId: "dev1" });
    await mgr.ensureKeyBundle();
    await mgr.ensureKeyBundle();
    await mgr.ensureKeyBundle();
    expect(httpCalls.filter((c) => c.path === "/api/chat/keys/upload")).toHaveLength(1);
  });

  it("topUpIfNeeded skips when count is healthy", async () => {
    const http = makeHttp(50); // above watermark of 20
    const mgr = new KeyBundleManager({ http, crypto, deviceId: "dev1" });
    await mgr.ensureKeyBundle();
    const r = await mgr.topUpIfNeeded();
    expect(r.topped).toBe(false);
    expect(httpCalls.filter((c) => c.path === "/api/chat/keys/topup")).toHaveLength(0);
  });

  it("topUpIfNeeded refills when count drops below watermark", async () => {
    const http = makeHttp(5); // below watermark
    const mgr = new KeyBundleManager({ http, crypto, deviceId: "dev1" });
    await mgr.ensureKeyBundle();
    httpCalls.length = 0;

    const r = await mgr.topUpIfNeeded();
    expect(r.topped).toBe(true);
    expect(r.newCount).toBe(100);
    const topup = httpCalls.find((c) => c.path === "/api/chat/keys/topup");
    expect(topup).toBeTruthy();
    const body = topup!.body as { oneTimeKeys: unknown[] };
    expect(body.oneTimeKeys.length).toBe(95); // 100 target - 5 existing
  });

  it("reuploadCurrentBundle errors if account doesn't exist yet", async () => {
    const mgr = new KeyBundleManager({ http: makeHttp(0), crypto, deviceId: "dev1" });
    await expect(mgr.reuploadCurrentBundle()).rejects.toThrow(/no account/);
  });
});

// ── SessionManager ───────────────────────────────────────────────────────────

describe("SessionManager", () => {
  let crypto: FakeCryptoAdapter;
  let claimAllCalls: number;
  let claimAllResp: ClaimedDevice[];

  beforeEach(async () => {
    crypto = new FakeCryptoAdapter();
    await crypto.generateAccount(10);
    claimAllCalls = 0;
    claimAllResp = [makeBundle("bob-phone")];
  });

  function makeHttp() {
    return new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchImpl: makeFetch({
        "POST /api/chat/keys/claim_all": async () => {
          claimAllCalls++;
          return jsonOk({ devices: claimAllResp });
        },
      }),
    });
  }

  it("first send claims peer bundles + creates outbound session", async () => {
    const sm = new SessionManager({ http: makeHttp(), crypto, selfDeviceId: "alice-mac" });
    const out = await sm.encryptForPeer("bob", "hello");
    expect(claimAllCalls).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].peerDeviceId).toBe("bob-phone");
    expect(out[0].msgType).toBe("prekey"); // first ever
  });

  it("second send to same peer reuses session — no new claim, msgType=normal", async () => {
    const sm = new SessionManager({ http: makeHttp(), crypto, selfDeviceId: "alice-mac" });
    await sm.encryptForPeer("bob", "first");
    const out = await sm.encryptForPeer("bob", "second");
    expect(claimAllCalls).toBe(1); // cached
    expect(out[0].msgType).toBe("normal");
  });

  it("returns empty array when peer has no devices (or has blocked us)", async () => {
    claimAllResp = [];
    const sm = new SessionManager({ http: makeHttp(), crypto, selfDeviceId: "alice-mac" });
    const out = await sm.encryptForPeer("bob", "hello");
    expect(out).toEqual([]);
  });

  it("fanout: send for two peer devices encrypts twice and creates two sessions", async () => {
    claimAllResp = [makeBundle("bob-phone"), makeBundle("bob-laptop")];
    const sm = new SessionManager({ http: makeHttp(), crypto, selfDeviceId: "alice-mac" });
    const out = await sm.encryptForPeer("bob", "hi");
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.peerDeviceId).sort()).toEqual(["bob-laptop", "bob-phone"]);
    expect(out.every((r) => r.msgType === "prekey")).toBe(true);
    expect(await sm.hasSession("bob", "bob-phone")).toBe(true);
    expect(await sm.hasSession("bob", "bob-laptop")).toBe(true);
  });

  it("decrypt happy path: outbound prekey → inbound prekey decrypt yields plaintext", async () => {
    // Alice -> Bob, then Bob decrypts.
    const aliceCrypto = new FakeCryptoAdapter();
    await aliceCrypto.generateAccount(10);
    const bobCrypto = new FakeCryptoAdapter();
    await bobCrypto.generateAccount(10);

    const alice = new SessionManager({ http: makeHttp(), crypto: aliceCrypto, selfDeviceId: "alice-mac" });
    const out = await alice.encryptForPeer("bob", "hello bob");
    expect(out).toHaveLength(1);
    const plain = await bobCrypto.decryptFromPeer("alice", "alice-mac", out[0].ciphertext, out[0].msgType);
    expect(plain).toBe("hello bob");
  });

  it("forgetPeerDevice removes session + cached bundle", async () => {
    const sm = new SessionManager({ http: makeHttp(), crypto, selfDeviceId: "alice-mac" });
    await sm.encryptForPeer("bob", "hi");
    expect(await sm.hasSession("bob", "bob-phone")).toBe(true);
    await sm.forgetPeerDevice("bob", "bob-phone");
    expect(await sm.hasSession("bob", "bob-phone")).toBe(false);
  });

  it("refreshPeerBundles forces a re-claim", async () => {
    const sm = new SessionManager({ http: makeHttp(), crypto, selfDeviceId: "alice-mac" });
    await sm.encryptForPeer("bob", "first");
    expect(claimAllCalls).toBe(1);
    await sm.refreshPeerBundles("bob");
    expect(claimAllCalls).toBe(2);
  });
});

// ── PeerDeviceCache ──────────────────────────────────────────────────────────

describe("PeerDeviceCache", () => {
  let calls: number;

  function makeHttpAndCache(devices: Array<{ deviceId: string; fingerprint: string; lastActiveAt: number }>) {
    calls = 0;
    const http = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchImpl: makeFetch({
        "GET /api/chat/keys/list_devices": () => {
          calls++;
          return jsonOk({ devices });
        },
      }),
    });
    return new PeerDeviceCache({ http, selfDeviceId: "alice-mac" });
  }

  it("first call fetches; subsequent returns cached", async () => {
    const cache = makeHttpAndCache([{ deviceId: "bob-phone", fingerprint: "FP", lastActiveAt: 1000 }]);
    const a = await cache.getPeerDevices("bob");
    const b = await cache.getPeerDevices("bob");
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(a[0].deviceId).toBe("bob-phone");
  });

  it("invalidate forces re-fetch", async () => {
    const cache = makeHttpAndCache([{ deviceId: "bob-phone", fingerprint: "FP", lastActiveAt: 1000 }]);
    await cache.getPeerDevices("bob");
    cache.invalidate("bob");
    await cache.getPeerDevices("bob");
    expect(calls).toBe(2);
  });

  it("noteNewPeerDevice augments without HTTP", async () => {
    const cache = makeHttpAndCache([{ deviceId: "bob-phone", fingerprint: "FP1", lastActiveAt: 1000 }]);
    await cache.getPeerDevices("bob");
    cache.noteNewPeerDevice("bob", { deviceId: "bob-laptop", fingerprint: "FP2", lastActiveAt: 2000 });
    const devices = await cache.getPeerDevices("bob");
    expect(devices).toHaveLength(2);
    expect(calls).toBe(1); // no extra fetch
  });

  it("noteNewPeerDevice is idempotent on duplicates", async () => {
    const cache = makeHttpAndCache([{ deviceId: "bob-phone", fingerprint: "FP", lastActiveAt: 1000 }]);
    await cache.getPeerDevices("bob");
    cache.noteNewPeerDevice("bob", { deviceId: "bob-phone", fingerprint: "FP", lastActiveAt: 1000 });
    const devices = await cache.getPeerDevices("bob");
    expect(devices).toHaveLength(1);
  });

  it("respects staleAfterMs", async () => {
    vi.useFakeTimers();
    try {
      const cache = makeHttpAndCache([{ deviceId: "bob-phone", fingerprint: "FP", lastActiveAt: 1000 }]);
      await cache.getPeerDevices("bob");
      vi.advanceTimersByTime(10 * 60 * 1000); // > default 5 min
      await cache.getPeerDevices("bob");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

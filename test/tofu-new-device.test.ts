// Two sets of tests in this file:
//
//   1. SessionManager WITHOUT background discovery (`backgroundDiscovery:
//      false`) — pins the "silent new peer device" behavior that the SDK
//      lived with for the 0.x line. Documents the explicit recovery paths
//      (`refreshPeerBundles`, reconnect, `forgetPeerDevice`) that a caller
//      needs when discovery is off.
//
//   2. SessionManager WITH background discovery (the new default in
//      0.10.0) — proves that bob's silent device IS caught up on alice's
//      very next send, no caller intervention required. Each completed
//      `encryptForPeer` kicks off a cheap `/keys/list_devices`; on diff,
//      the same plaintext(s) get encrypted for the new device and emitted
//      via `onCatchUpEnvelope` for the SDK to ship.
//
// The contrast between the two groups is the point — same scenario, same
// inputs; the only difference is whether discovery is on.

import { beforeEach, describe, expect, it } from "vitest";

import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { SessionManager, type CatchUpEnvelope } from "../src/sessions.js";
import type { ClaimedDevice, MintTokenResponse } from "../src/types.js";
import { HttpClient } from "../src/transport/http.js";

function fakeMint(): MintTokenResponse {
  return {
    chatToken: "header.body.sig",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    chatNodeWsUrl: "wss://node.test/chat/ws",
  };
}

function makeBundle(deviceId: string): ClaimedDevice {
  return {
    deviceId,
    identityKeyCurve: `IK_C-${deviceId}`,
    identityKeyEd: `IK_E-${deviceId}`,
    signedPrekey: `SP-${deviceId}`,
    signedPrekeySig: `SPS-${deviceId}`,
    oneTimeKey: { id: `${deviceId}-otk-1`, public: `OTK-${deviceId}` },
    fallbackPrekey: `FB-${deviceId}`,
    fallbackPrekeySig: `FBS-${deviceId}`,
    fingerprint: `FP-${deviceId}`,
    lastActiveAt: 1000,
  };
}

function makeListDevicesEntry(deviceId: string) {
  return { deviceId, fingerprint: `FP-${deviceId}`, lastActiveAt: 1000 };
}

// Sleep just long enough that the fire-and-forget microtask scheduled by
// maybeKickOffDiscovery runs to completion. The mock fetch resolves
// synchronously, so a single setTimeout(0) is enough to let all queued
// microtasks drain.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("SessionManager — backgroundDiscovery: false (legacy behavior)", () => {
  let crypto: FakeCryptoAdapter;
  let claimAllResp: ClaimedDevice[];
  let claimAllCalls: number;

  beforeEach(async () => {
    crypto = new FakeCryptoAdapter();
    await crypto.generateAccount(10);
    claimAllCalls = 0;
    claimAllResp = [makeBundle("bob-A")];
  });

  function makeHttp(): HttpClient {
    return new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchHttpBearer: async () => "fake.bearer",
      fetchImpl: async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/keys/claim_all") {
          claimAllCalls++;
          return new Response(JSON.stringify({ devices: claimAllResp }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "not_mocked" }), { status: 501 });
      },
    });
  }

  function makeAlice() {
    return new SessionManager({
      http: makeHttp(),
      crypto,
      selfDeviceId: "alice-mac",
      backgroundDiscovery: false,
    });
  }

  it("silent new device → alice's fanout stays on bob-A until something refreshes", async () => {
    const alice = makeAlice();

    const phase1 = await alice.encryptForPeer("bob", "warm-up");
    expect(phase1.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);
    expect(claimAllCalls).toBe(1);

    claimAllResp = [makeBundle("bob-A"), makeBundle("bob-B")];

    const phase2 = await alice.encryptForPeer("bob", "msg-after-new-device");
    // ★ With discovery off, bob-B sits idle holding a key bundle no one
    //   encrypts to. Verification flags don't change this; only an
    //   explicit refresh (next test) does.
    expect(phase2.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);
    expect(claimAllCalls).toBe(1);

    const phase3 = await alice.encryptForPeer("bob", "yet-another-msg");
    expect(phase3.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);
    expect(claimAllCalls).toBe(1);
  });

  it("explicit refreshPeerBundles is the manual recovery path", async () => {
    const alice = makeAlice();
    await alice.encryptForPeer("bob", "warm-up");
    expect(claimAllCalls).toBe(1);

    claimAllResp = [makeBundle("bob-A"), makeBundle("bob-B")];

    let out = await alice.encryptForPeer("bob", "before-refresh");
    expect(out.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);
    expect(claimAllCalls).toBe(1);

    await alice.refreshPeerBundles("bob");
    expect(claimAllCalls).toBe(2);

    out = await alice.encryptForPeer("bob", "after-refresh");
    expect(out.map((e) => e.peerDeviceId).sort()).toEqual(["bob-A", "bob-B"]);
  });

  it("reconnect rebuilds bundleCache — fresh SessionManager picks up the new device", async () => {
    const alice1 = makeAlice();
    let out = await alice1.encryptForPeer("bob", "msg-before-new-device");
    expect(out.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);
    expect(claimAllCalls).toBe(1);

    claimAllResp = [makeBundle("bob-A"), makeBundle("bob-B")];

    // Simulate reconnect: a fresh SessionManager with empty in-memory
    // bundleCache. The persistent Olm crypto adapter is reused — that's
    // the real-world shape (Olm account survives via KV pickle).
    const alice2 = makeAlice();
    out = await alice2.encryptForPeer("bob", "msg-after-reconnect");
    expect(out.map((e) => e.peerDeviceId).sort()).toEqual(["bob-A", "bob-B"]);
    expect(claimAllCalls).toBe(2);
  });

  it("forgetPeerDevice empties the entry but doesn't auto-claim — refresh still needed", async () => {
    const alice = makeAlice();
    await alice.encryptForPeer("bob", "warm-up");
    expect(claimAllCalls).toBe(1);

    claimAllResp = [makeBundle("bob-A"), makeBundle("bob-B")];

    let out = await alice.encryptForPeer("bob", "before");
    expect(out.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);
    expect(claimAllCalls).toBe(1);

    await alice.forgetPeerDevice("bob", "bob-A");
    out = await alice.encryptForPeer("bob", "after-forget");
    expect(out).toEqual([]);
    expect(claimAllCalls).toBe(1);

    await alice.refreshPeerBundles("bob");
    out = await alice.encryptForPeer("bob", "after-refresh");
    expect(out.map((e) => e.peerDeviceId).sort()).toEqual(["bob-A", "bob-B"]);
  });
});

describe("SessionManager — backgroundDiscovery: true (the new default)", () => {
  let crypto: FakeCryptoAdapter;
  let claimAllResp: ClaimedDevice[];
  let claimAllCalls: number;
  let listDevicesResp: { deviceId: string; fingerprint: string; lastActiveAt: number }[];
  let listDevicesCalls: number;
  let catchUps: CatchUpEnvelope[];

  beforeEach(async () => {
    crypto = new FakeCryptoAdapter();
    await crypto.generateAccount(10);
    claimAllCalls = 0;
    listDevicesCalls = 0;
    claimAllResp = [makeBundle("bob-A")];
    listDevicesResp = [makeListDevicesEntry("bob-A")];
    catchUps = [];
  });

  function makeHttp(): HttpClient {
    return new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchHttpBearer: async () => "fake.bearer",
      fetchImpl: async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/keys/claim_all") {
          claimAllCalls++;
          return new Response(JSON.stringify({ devices: claimAllResp }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (req.method === "GET" && url.pathname === "/keys/list_devices") {
          listDevicesCalls++;
          return new Response(JSON.stringify({ devices: listDevicesResp }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "not_mocked" }), { status: 501 });
      },
    });
  }

  function makeAlice(overrides: Partial<{
    floorMs: number;
    onCatchUp: (env: CatchUpEnvelope) => void;
  }> = {}) {
    return new SessionManager({
      http: makeHttp(),
      crypto,
      selfDeviceId: "alice-mac",
      // backgroundDiscovery defaults to true; explicit for clarity.
      backgroundDiscovery: true,
      // Floor at 0 by default so back-to-back tests don't see suppressed
      // discoveries from a previous call. The rate-limit test overrides
      // with a real value to verify the floor logic.
      backgroundDiscoveryFloorMs: overrides.floorMs ?? 0,
      onCatchUpEnvelope: overrides.onCatchUp ?? ((env) => catchUps.push(env)),
    });
  }

  it("silent new device → next send emits a catch-up envelope for that device", async () => {
    const alice = makeAlice();

    // Phase 1: warm-up. Only bob-A exists. Discovery sees no diff.
    const phase1 = await alice.encryptForPeer("bob", "warm-up");
    expect(phase1.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);
    await flush();
    expect(catchUps).toEqual([]); // no new device → no catch-up

    // Phase 2: bob silently adds bob-B. Backend now returns both for
    // BOTH list_devices and claim_all.
    listDevicesResp = [makeListDevicesEntry("bob-A"), makeListDevicesEntry("bob-B")];
    claimAllResp = [makeBundle("bob-A"), makeBundle("bob-B")];

    // alice's next send — synchronous path still goes only to bob-A
    // because bundleCache is stale. Discovery kicks off in parallel.
    const phase2 = await alice.encryptForPeer("bob", "msg-during-discovery");
    expect(phase2.map((e) => e.peerDeviceId)).toEqual(["bob-A"]);

    // Background discovery: list_devices → diff → claim_all refresh →
    // encrypt the same plaintext for bob-B → emit.
    await flush();
    expect(catchUps.length).toBe(1);
    expect(catchUps[0].peerUserId).toBe("bob");
    expect(catchUps[0].peerDeviceId).toBe("bob-B");
    expect(typeof catchUps[0].ciphertext).toBe("string");
    expect(catchUps[0].msgType).toBe("prekey");

    // bundleCache is now fresh — subsequent send fanouts naturally to both.
    const phase3 = await alice.encryptForPeer("bob", "msg-after-discovery");
    expect(phase3.map((e) => e.peerDeviceId).sort()).toEqual(["bob-A", "bob-B"]);
  });

  it("rate limit: rapid sends produce ONE discovery within the floor window", async () => {
    const alice = makeAlice({ floorMs: 60_000 });

    // First send → first discovery.
    await alice.encryptForPeer("bob", "msg-1");
    await flush();
    expect(listDevicesCalls).toBe(1);

    // Subsequent sends within 60s → no new discovery.
    await alice.encryptForPeer("bob", "msg-2");
    await alice.encryptForPeer("bob", "msg-3");
    await alice.encryptForPeer("bob", "msg-4");
    await flush();
    expect(listDevicesCalls).toBe(1);
  });

  it("queue: messages sent during the in-flight discovery window all get caught up", async () => {
    // Mock /keys/list_devices with a deferred resolution so concurrent
    // sends can pile up in pendingCatchUp before discovery returns.
    let resolveList!: (devices: typeof listDevicesResp) => void;
    const pendingList = new Promise<typeof listDevicesResp>((r) => { resolveList = r; });

    const http = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchHttpBearer: async () => "fake.bearer",
      fetchImpl: async (input, init) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/keys/claim_all") {
          claimAllCalls++;
          return new Response(JSON.stringify({ devices: claimAllResp }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (req.method === "GET" && url.pathname === "/keys/list_devices") {
          listDevicesCalls++;
          const devices = await pendingList;
          return new Response(JSON.stringify({ devices }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "not_mocked" }), { status: 501 });
      },
    });

    const alice = new SessionManager({
      http,
      crypto,
      selfDeviceId: "alice-mac",
      backgroundDiscovery: true,
      backgroundDiscoveryFloorMs: 0,
      onCatchUpEnvelope: (env) => catchUps.push(env),
    });

    // Warm up: cold cache → claim_all → bundleCache = [bob-A]. Also kicks
    // off the in-flight discovery (which hangs on pendingList).
    await alice.encryptForPeer("bob", "msg-1");

    // bob silently adds bob-B AFTER the warm-up but before discovery
    // returns. Mutating claimAllResp here so the eventual claim_all
    // refresh sees bob-B.
    claimAllResp = [makeBundle("bob-A"), makeBundle("bob-B")];

    // More sends while discovery is pending — these should queue.
    await alice.encryptForPeer("bob", "msg-2");
    await alice.encryptForPeer("bob", "msg-3");

    // Now resolve list_devices with the new device list.
    resolveList([makeListDevicesEntry("bob-A"), makeListDevicesEntry("bob-B")]);
    await flush();
    await flush(); // give the per-target encrypt loop time to finish

    // All three plaintexts should have produced catch-up envelopes for
    // bob-B (one envelope per queued plaintext × one new device).
    expect(catchUps.map((e) => e.peerDeviceId)).toEqual(["bob-B", "bob-B", "bob-B"]);
    // Order preserved (in-order encrypt is what keeps the Olm ratchet
    // happy on the recipient side).
    expect(catchUps.length).toBe(3);
  });

  it("no-op when device list is unchanged — list_devices fires, no claim_all, no catch-up", async () => {
    const alice = makeAlice();

    await alice.encryptForPeer("bob", "warm-up"); // claim_all #1 (cold cache)
    await flush();
    expect(claimAllCalls).toBe(1);
    expect(listDevicesCalls).toBe(1);
    expect(catchUps).toEqual([]); // device list unchanged → no diff
  });

  it("backgroundDiscovery: false disables everything — no list_devices, no catch-up", async () => {
    const alice = new SessionManager({
      http: makeHttp(),
      crypto,
      selfDeviceId: "alice-mac",
      backgroundDiscovery: false,
      onCatchUpEnvelope: (env) => catchUps.push(env),
    });

    listDevicesResp = [makeListDevicesEntry("bob-A"), makeListDevicesEntry("bob-B")];
    claimAllResp = [makeBundle("bob-A"), makeBundle("bob-B")];

    await alice.encryptForPeer("bob", "msg");
    await flush();

    expect(listDevicesCalls).toBe(0); // explicitly off
    expect(catchUps).toEqual([]);
  });
});

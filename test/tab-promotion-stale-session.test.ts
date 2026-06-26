// Regression: a tab promoted to "primary" must drop its in-memory Olm
// session cache so it reloads the persisted (possibly advanced) ratchet
// state from KV. Two tabs are the SAME device (shared KV / one Olm account
// + sessions on disk) but each tab process keeps its OWN in-memory Map of
// Session objects. If a re-promoted tab keeps a STALE in-memory ratchet,
// it encrypts from a position the peer has already moved past — the peer
// can't decrypt, forgets the session, and the conversation deadlocks.
//
// There are TWO promotion paths in index.ts and BOTH must clear the cache:
//   1. stealAndActivate  — explicit `takeOver()` (steal the Web Lock).
//   2. armBackgroundLockWait — automatic promotion when the current
//      primary disconnects and a demoted tab's queued lock request is
//      granted.
//
// These tests drive the REAL promotion code in Node by injecting a faithful
// in-memory `navigator.locks` and a crypto adapter that models the
// persist-to-shared-disk + stale-in-memory-cache split that the real
// OlmCryptoAdapter has (the stock FakeCryptoAdapter is a stateless Set and
// cannot exhibit ratchet divergence).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DTelecomSecureChat } from "../src/index.js";
import { FakeCryptoAdapter } from "../src/crypto/fake-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import type { CryptoAdapter, OutboundEnvelope, UploadBundle } from "../src/crypto/interface.js";
import type { ClaimedDevice, MintTokenResponse } from "../src/types.js";

// ── Faithful in-memory Web Locks ────────────────────────────────────────────
// Implements the slice of the Web Locks API that index.ts uses:
//   request(name, { mode:"exclusive", ifAvailable:true }, cb)  — acquireLockOrWait
//   request(name, { mode:"exclusive" }, cb)                    — armBackgroundLockWait (queues)
//   request(name, { mode:"exclusive", steal:true }, cb)        — stealAndActivate
// A held lock is released when its callback's returned promise settles
// (index.ts holds via `await lockHold`, resolved by releaseHeldLock()).
// Stealing rejects the current holder's request promise (→ demote) and hands
// the lock to the stealer; queued waiters are granted FIFO on release.
function makeAbortError(): Error {
  const e = new Error("The lock request was aborted (stolen)");
  e.name = "AbortError";
  return e;
}

interface LockRequestOptions {
  mode?: string;
  ifAvailable?: boolean;
  steal?: boolean;
}
type LockCallback = (lock: { name: string; mode: string } | null) => unknown;

class FakeWebLocks {
  private held = new Map<string, { abort: () => void }>();
  private queue = new Map<string, Array<() => void>>();

  request(name: string, options: LockRequestOptions, cb: LockCallback): Promise<unknown> {
    const { ifAvailable = false, steal = false } = options ?? {};
    if (steal) {
      this.held.get(name)?.abort();
      this.held.delete(name);
      return this.grant(name, cb);
    }
    if (this.held.has(name)) {
      if (ifAvailable) return Promise.resolve().then(() => cb(null));
      return new Promise((resolve, reject) => {
        const arr = this.queue.get(name) ?? [];
        arr.push(() => this.grant(name, cb).then(resolve, reject));
        this.queue.set(name, arr);
      });
    }
    return this.grant(name, cb);
  }

  private grant(name: string, cb: LockCallback): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.held.set(name, {
        abort: () => {
          if (settled) return;
          settled = true;
          reject(makeAbortError()); // stolen — stealer now holds; don't run queue
        },
      });
      Promise.resolve()
        .then(() => cb({ name, mode: "exclusive" }))
        .then(
          (val) => {
            if (settled) return;
            settled = true;
            this.releaseAndDrain(name);
            resolve(val);
          },
          (err) => {
            if (settled) return;
            settled = true;
            this.releaseAndDrain(name);
            reject(err);
          },
        );
    });
  }

  private releaseAndDrain(name: string): void {
    this.held.delete(name);
    const arr = this.queue.get(name);
    if (arr && arr.length > 0) arr.shift()!();
  }
}

let savedNavigator: PropertyDescriptor | undefined;
beforeEach(() => {
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { locks: new FakeWebLocks() },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
});

// ── Ratchet-modelling crypto adapter ────────────────────────────────────────
// Models the persist/cache split of the real OlmCryptoAdapter:
//   • `disk` (shared across tabs of the same device) holds the persisted
//     ratchet index per session.
//   • `cache` (per tab) is the in-memory view that can go STALE.
// Account/bundle/OTK plumbing is delegated to the stock FakeCryptoAdapter.
class RatchetCryptoAdapter implements CryptoAdapter {
  private delegate = new FakeCryptoAdapter();
  private cache = new Map<string, number>();
  constructor(private disk: Map<string, number>) {}

  init(): Promise<void> { return this.delegate.init(); }
  hasAccount(): Promise<boolean> { return this.delegate.hasAccount(); }
  generateAccount(n: number): Promise<UploadBundle> { return this.delegate.generateAccount(n); }
  getCurrentBundle(): Promise<UploadBundle> { return this.delegate.getCurrentBundle(); }
  generateOneTimeKeys(n: number): Promise<{ id: string; public: string }[]> {
    return this.delegate.generateOneTimeKeys(n);
  }
  unusedOneTimeKeyCount(): Promise<number> { return this.delegate.unusedOneTimeKeyCount(); }

  private load(key: string): number {
    if (!this.cache.has(key)) this.cache.set(key, this.disk.get(key) ?? 0);
    return this.cache.get(key)!;
  }

  async encryptForPeer(p: string, d: string, _b: ClaimedDevice, plain: string): Promise<OutboundEnvelope> {
    const key = `${p}|${d}`;
    const next = this.load(key) + 1;
    this.cache.set(key, next);
    this.disk.set(key, next);
    return { ciphertext: btoa(`${next}:${plain}`), msgType: next === 1 ? "prekey" : "normal" };
  }
  async decryptFromPeer(p: string, d: string, ct: string): Promise<string> {
    const [pos, ...rest] = atob(ct).split(":");
    const key = `${p}|${d}`;
    this.cache.set(key, Number(pos));
    this.disk.set(key, Number(pos));
    return rest.join(":");
  }
  forgetSession(p: string, d: string): Promise<void> {
    this.cache.delete(`${p}|${d}`);
    return Promise.resolve();
  }
  async hasSession(p: string, d: string): Promise<boolean> {
    return this.cache.has(`${p}|${d}`) || this.disk.has(`${p}|${d}`);
  }
  // The fix-under-test calls this on every promotion to drop stale state.
  clearSessionCache(): void { this.cache.clear(); }

  // ── test accessors ──
  /** Pretend this tab was primary earlier and chatted up to `idx` (stale cache). */
  primeStaleCache(p: string, d: string, idx: number): void { this.cache.set(`${p}|${d}`, idx); }
  /** Ratchet index this tab WOULD use for its next outbound message. */
  nextSendIndex(p: string, d: string): number { return this.load(`${p}|${d}`) + 1; }
}

// ── SDK harness ──────────────────────────────────────────────────────────────
const PEER = { user: "bob", dev: "bob-dev-1" };
const PEER_BUNDLE = {} as ClaimedDevice;

function btoaUrl(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function mintAlice(): MintTokenResponse {
  const jwt = "h." + btoaUrl(JSON.stringify({ sub: "alice", did: "alice-dev", exp: 9999999999 })) + ".s";
  return { chatToken: jwt, expiresAt: Math.floor(Date.now() / 1000) + 3600, chatNodeWsUrl: "wss://node.test" };
}
function makeMockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if (u.pathname === "/keys/upload") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/keys/count") return new Response(JSON.stringify({ count: 100 }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "not_implemented" }), { status: 501, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

// No-op WebSocket so ws.connect() resolves without a real node.
class StubWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => { this.readyState = 1; this.onopen?.({} as Event); }, 0);
  }
  send(_: string): void {}
  close(): void { this.readyState = 3; this.onclose?.({} as CloseEvent); }
}
let realWS: typeof WebSocket;
beforeEach(() => { realWS = globalThis.WebSocket; (globalThis as { WebSocket: unknown }).WebSocket = StubWebSocket; });
afterEach(() => { (globalThis as { WebSocket: unknown }).WebSocket = realWS; });

function connect(baseURL: string, store: MemoryKVStore, crypto: CryptoAdapter): Promise<DTelecomSecureChat> {
  return DTelecomSecureChat.connect({
    apiBaseURL: baseURL,
    selfUserId: "alice",
    fetchChatToken: async () => mintAlice(),
    fetchHttpBearer: async () => "fake.bearer",
    store,
    crypto,
    fetchImpl: makeMockFetch(),
  });
}

async function waitFor(pred: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("primary-tab promotion must reload session state (no stale ratchet)", () => {
  it("scenario 1 — takeOver() steal-back: re-promoted tab continues from persisted ratchet", async () => {
    const baseURL = `http://steal-${Math.random().toString(36).slice(2, 8)}`;
    const store = new MemoryKVStore();
    const disk = new Map<string, number>();
    const cryptoA = new RatchetCryptoAdapter(disk);
    const cryptoB = new RatchetCryptoAdapter(disk);

    const tabA = await connect(baseURL, store, cryptoA);
    const tabB = await connect(baseURL, store, cryptoB);
    expect(tabA.isPrimary()).toBe(true);
    expect(tabB.isPrimary()).toBe(false);

    // tabA (primary) sends one message: ratchet 0 → 1 (persisted to disk).
    await cryptoA.encryptForPeer(PEER.user, PEER.dev, PEER_BUNDLE, "from A");
    expect(disk.get(`${PEER.user}|${PEER.dev}`)).toBe(1);

    // tabB takes over and sends: loads disk(1) → advances to 2.
    await tabB.takeOver();
    expect(tabB.isPrimary()).toBe(true);
    await cryptoB.encryptForPeer(PEER.user, PEER.dev, PEER_BUNDLE, "from B");
    expect(disk.get(`${PEER.user}|${PEER.dev}`)).toBe(2);

    // tabA steals primary back. Its in-memory cache is the STALE fork at 1.
    await tabA.takeOver();
    expect(tabA.isPrimary()).toBe(true);

    // The fix: promotion cleared tabA's session cache, so its next send
    // continues from the persisted ratchet (2 → 3). Without the fix tabA
    // re-uses index 2 — a ratchet collision the peer can't decrypt.
    expect(cryptoA.nextSendIndex(PEER.user, PEER.dev)).toBe(3);

    await tabA.disconnect();
    await tabB.disconnect();
  });

  it("scenario 2 — background promotion (primary disconnects): promoted tab reloads persisted ratchet", async () => {
    const baseURL = `http://bg-${Math.random().toString(36).slice(2, 8)}`;
    const store = new MemoryKVStore();
    const disk = new Map<string, number>();
    const cryptoPrimary = new RatchetCryptoAdapter(disk);
    const cryptoSurvivor = new RatchetCryptoAdapter(disk);

    const primaryTab = await connect(baseURL, store, cryptoPrimary);
    const survivorTab = await connect(baseURL, store, cryptoSurvivor);
    expect(primaryTab.isPrimary()).toBe(true);
    expect(survivorTab.isPrimary()).toBe(false); // armed a background lock wait

    // survivorTab had been primary earlier and chatted up to ratchet 1, then
    // was demoted to secondary (KEEPING its stale in-memory cache — the bug).
    cryptoSurvivor.primeStaleCache(PEER.user, PEER.dev, 1);
    disk.set(`${PEER.user}|${PEER.dev}`, 1);

    // The current primary advances the shared ratchet past survivor's view.
    await cryptoPrimary.encryptForPeer(PEER.user, PEER.dev, PEER_BUNDLE, "from primary");
    expect(disk.get(`${PEER.user}|${PEER.dev}`)).toBe(2);

    // Primary disconnects → survivorTab auto-promotes via armBackgroundLockWait.
    await primaryTab.disconnect();
    await waitFor(() => survivorTab.isPrimary());

    // The fix: background promotion also cleared the session cache, so the
    // survivor continues from persisted ratchet (2 → 3), not stale (1 → 2).
    expect(cryptoSurvivor.nextSendIndex(PEER.user, PEER.dev)).toBe(3);

    await survivorTab.disconnect();
  });
});

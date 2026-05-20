// SessionManager — orchestrates outbound and inbound Olm sessions across
// peer (user, device) pairs. Owns the claim_all flow for outbound, the
// prekey-message bootstrap for inbound, and serializes session creation
// per peer device so a burst of sends can't race two outbound sessions.
//
// All persistence lives in the underlying CryptoAdapter; this layer is
// stateless other than its in-memory locking.

import type { CryptoAdapter, OutboundEnvelope } from "./crypto/interface.js";
import type { HttpClient } from "./transport/http.js";
import type { ClaimedDevice } from "./types.js";

export interface SessionManagerOptions {
  http: HttpClient;
  crypto: CryptoAdapter;
  /** This device's id, used to authenticate /keys/claim_all. */
  selfDeviceId: string;
  /** This user's id. When sending to self (multi-device echo), used to
   *  filter our own device from the fanout. */
  selfUserId?: string | null;
  /** When `true` (default), every `encryptForPeer` kicks off a background
   *  `/keys/list_devices` call to detect peer devices the bundleCache
   *  doesn't yet know about. On discovery, the same plaintext is
   *  encrypted for the new device(s) and emitted via
   *  `onCatchUpEnvelope` — the SDK ships them through the same outbound
   *  path as the original send. Rate-limited per peer (see
   *  `backgroundDiscoveryFloorMs`). Set to `false` to disable. */
  backgroundDiscovery?: boolean;
  /** Minimum time between background-discovery calls for the same peer.
   *  Defaults to 30s. A burst of rapid sends to the same peer triggers
   *  exactly one discovery within this window. */
  backgroundDiscoveryFloorMs?: number;
  /** Callback fired ONCE per new-device-catch-up envelope. The SDK wires
   *  this to its outbound shipper so caught-up ciphertexts travel the
   *  same chatSend / offline-envelope path as the immediate fanout. */
  onCatchUpEnvelope?: (env: CatchUpEnvelope) => void;
}

/** Emitted by background discovery when a peer device the bundleCache
 *  didn't know about gets caught up with the same plaintext. */
export interface CatchUpEnvelope {
  peerUserId: string;
  peerDeviceId: string;
  ciphertext: string;
  msgType: "prekey" | "normal";
}

/**
 * EncryptForResult holds per-target encryption output, ready to be put
 * into a chatSend frame's targets[].
 */
export interface EncryptForResult {
  peerDeviceId: string;
  ciphertext: string;
  msgType: "prekey" | "normal";
}

export class SessionManager {
  /**
   * Per-peer-device locks to serialize outbound session creation. Without
   * this, two parallel sends to the same fresh peer would each consume an
   * OTK and create two competing sessions.
   */
  private locks = new Map<string, Promise<void>>();

  // Cached peer-device bundles. Refreshed by device_discovery; consumed
  // here on send. null = no claim attempted yet for this peer.
  private bundleCache = new Map<string, ClaimedDevice[]>();

  // In-flight claim_all promises keyed by peer user. Coalesces parallel
  // first-time sends so they share one claim_all → one OTK consumed → one
  // outbound session per peer device. Without this, two parallel sendText
  // calls both miss the cache, both call claim_all, both consume an OTK,
  // both create outbound sessions, the second persisted session overwrites
  // the first — and subsequent messages encrypt with a session the peer's
  // inbound side never saw.
  private inflightRefresh = new Map<string, Promise<ClaimedDevice[]>>();

  // Last-discovery timestamp per peer, in ms since epoch. Background
  // discovery on `encryptForPeer` is gated by `backgroundDiscoveryFloorMs`
  // (default 30s) so a chatty burst doesn't fire one list_devices per
  // message.
  private lastDiscoveryAt = new Map<string, number>();

  // In-flight background-discovery promises keyed by peer user. Coalesces
  // parallel sends so they share one list_devices call.
  private inflightDiscovery = new Map<string, Promise<void>>();

  // Plaintexts to catch up for new devices, accumulated while a discovery
  // is in flight. Drained ONCE (atomically with the bundleCache refresh)
  // when discovery returns. Subsequent sends after the drain use the
  // fresh bundleCache for natural fanout and don't need catch-up.
  private pendingCatchUp = new Map<string, string[]>();

  // When ensurePeerBundles observes a cached EMPTY result (claim_all
  // returned no devices), we keep it cached for this short window before
  // re-claiming. Bounds load on a permanently-empty peer (blocked,
  // deleted account) while letting a transient empty resolve within
  // seconds rather than requiring a full SDK reconstruction. Added in
  // 0.12.1 as defense against any path that leaves [] in bundleCache.
  private static readonly EMPTY_CACHE_COOLDOWN_MS = 5_000;
  private emptyCacheUntil = new Map<string, number>();

  constructor(private opts: SessionManagerOptions) {}

  /**
   * Encrypt one plaintext for ALL of a peer's currently-known devices.
   * On first contact OR when bundleCache is empty for this peer, calls
   * claim_all to fetch fresh bundles (which atomically pop OTKs).
   *
   * Returns an empty array when the peer has no chat-registered devices
   * (or has blocked the caller — same shape; see contract §2.5).
   */
  async encryptForPeer(peerUserId: string, plaintext: string): Promise<EncryptForResult[]> {
    let devices = await this.ensurePeerBundles(peerUserId);
    // Multi-device self-echo path: filter our own device out of the fanout
    // so we don't try to establish an Olm session with ourselves.
    if (this.opts.selfUserId && peerUserId === this.opts.selfUserId) {
      devices = devices.filter((d) => d.deviceId !== this.opts.selfDeviceId);
    }
    if (devices.length === 0) {
      // No known devices — still kick off discovery so a future send picks
      // up bob-B even when bob's first device-set was empty at cold start.
      this.maybeKickOffDiscovery(peerUserId, plaintext, devices);
      return [];
    }

    const results: EncryptForResult[] = [];
    for (const dev of devices) {
      const env = await this.encryptForOneDevice(peerUserId, dev, plaintext);
      results.push({ peerDeviceId: dev.deviceId, ciphertext: env.ciphertext, msgType: env.msgType });
    }

    // After the synchronous fanout, kick off background discovery for any
    // peer devices the bundleCache didn't know about. Fire-and-forget —
    // the original send is NOT blocked on the discovery network call.
    this.maybeKickOffDiscovery(peerUserId, plaintext, devices);

    return results;
  }

  /**
   * Decrypt an inbound ciphertext from (peerUserId, peerDeviceId). On
   * msgType=="prekey" with no existing session, creates an inbound
   * session from the prekey message itself — no claim needed.
   */
  async decrypt(
    peerUserId: string,
    peerDeviceId: string,
    ciphertext: string,
    msgType: "prekey" | "normal",
  ): Promise<string> {
    return this.opts.crypto.decryptFromPeer(peerUserId, peerDeviceId, ciphertext, msgType);
  }

  /**
   * Drop the cached bundle list and any session with this peer device.
   * Used on decrypt-failure recovery, before a re-claim.
   *
   * Critical (0.12.1): when the filter produces an empty array, we
   * DELETE the cache entry entirely instead of leaving []. Otherwise
   * the next `ensurePeerBundles` would short-circuit on the empty
   * cache and return [] without re-claiming — which is the bug that
   * stuck users in peer_unreachable after a decrypt failure (typically
   * triggered by the peer rotating their device).
   */
  async forgetPeerDevice(peerUserId: string, peerDeviceId: string): Promise<void> {
    const cached = this.bundleCache.get(peerUserId);
    if (cached) {
      const filtered = cached.filter((d) => d.deviceId !== peerDeviceId);
      if (filtered.length === 0) {
        this.bundleCache.delete(peerUserId);
        this.emptyCacheUntil.delete(peerUserId);
      } else {
        this.bundleCache.set(peerUserId, filtered);
      }
    }
    await this.opts.crypto.forgetSession(peerUserId, peerDeviceId);
  }

  /** Test/diagnostic helper. */
  async hasSession(peerUserId: string, peerDeviceId: string): Promise<boolean> {
    return this.opts.crypto.hasSession(peerUserId, peerDeviceId);
  }

  /**
   * Number of cached devices for `peerUserId` that we'd actually fanout
   * to (excludes selfDeviceId when peerUserId === selfUserId). Returns
   * `null` when no claim has been attempted yet for this peer — caller
   * should treat that as "unknown, prefer refresh."
   */
  cachedFanoutSize(peerUserId: string): number | null {
    const cached = this.bundleCache.get(peerUserId);
    if (!cached) return null;
    if (this.opts.selfUserId && peerUserId === this.opts.selfUserId) {
      return cached.filter((d) => d.deviceId !== this.opts.selfDeviceId).length;
    }
    return cached.length;
  }

  /**
   * Force a refresh of peer bundles (e.g., from device_discovery on a
   * detected new peer device). Calls claim_all again; subsequent sends
   * use the new bundles. Pops fresh OTKs server-side.
   */
  async refreshPeerBundles(peerUserId: string): Promise<ClaimedDevice[]> {
    const res = await this.opts.http.claimAll(this.opts.selfDeviceId, peerUserId);
    this.bundleCache.set(peerUserId, res.devices);
    return res.devices;
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private async ensurePeerBundles(peerUserId: string): Promise<ClaimedDevice[]> {
    const cached = this.bundleCache.get(peerUserId);
    // Non-empty cache: hit. Use it.
    if (cached && cached.length > 0) return cached;
    // Empty cache (claim_all previously returned []): treat as a soft miss.
    // Re-claim, but throttled by EMPTY_CACHE_COOLDOWN_MS so we don't hammer
    // claim_all on a genuinely-empty peer (blocked, deleted account).
    // Before 0.12.1 the SDK returned [] from the cache here without re-
    // claiming, which stuck the SDK in peer_unreachable until the SDK
    // instance was reconstructed (e.g., full page reload).
    if (cached && cached.length === 0) {
      const until = this.emptyCacheUntil.get(peerUserId) ?? 0;
      if (Date.now() < until) return cached;
    }
    const inflight = this.inflightRefresh.get(peerUserId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const res = await this.refreshPeerBundles(peerUserId);
        if (res.length === 0) {
          this.emptyCacheUntil.set(
            peerUserId,
            Date.now() + SessionManager.EMPTY_CACHE_COOLDOWN_MS,
          );
        } else {
          this.emptyCacheUntil.delete(peerUserId);
        }
        return res;
      } finally {
        this.inflightRefresh.delete(peerUserId);
      }
    })();
    this.inflightRefresh.set(peerUserId, p);
    return p;
  }

  // Upper bound on plaintexts queued for catch-up during a single
  // discovery window. Bursts beyond this are dropped (best-effort).
  // 100 is generous — at 30s floor + typical chat rate it's hundreds
  // of messages worth of headroom.
  private static readonly DISCOVERY_QUEUE_CAP = 100;

  /**
   * Schedules a background `/keys/list_devices` for `peerUserId` unless
   *   (a) backgroundDiscovery is disabled,
   *   (b) we're sending to ourselves (self-fanout owns its own refresh).
   * If a discovery is already in flight for this peer, the plaintext is
   * appended to the catch-up queue and a new discovery is NOT started.
   * If under the rate-limit floor since the last completed discovery,
   * no new discovery is started AND nothing is queued (the floor is the
   * promise that we won't re-check more than once per window — anything
   * the caller wants delivered in this window must rely on natural
   * fanout from the current bundleCache).
   * Always returns synchronously — caller does NOT await.
   */
  private maybeKickOffDiscovery(
    peerUserId: string,
    plaintext: string,
    knownDevices: ClaimedDevice[],
  ): void {
    if (this.opts.backgroundDiscovery === false) return;
    if (peerUserId === this.opts.selfUserId) return; // self-fanout owns its own refresh

    // Discovery already running for this peer → queue plaintext for the
    // in-flight catch-up window. Once that discovery returns, all queued
    // plaintexts get encrypted for any newly-discovered devices.
    if (this.inflightDiscovery.has(peerUserId)) {
      const q = this.pendingCatchUp.get(peerUserId);
      if (q && q.length < SessionManager.DISCOVERY_QUEUE_CAP) {
        q.push(plaintext);
      }
      return;
    }

    const floor = this.opts.backgroundDiscoveryFloorMs ?? 30_000;
    const lastAt = this.lastDiscoveryAt.get(peerUserId) ?? 0;
    if (Date.now() - lastAt < floor) return;

    // Start a fresh discovery. Seed the queue with this plaintext —
    // additional concurrent sends append to it via the branch above.
    this.pendingCatchUp.set(peerUserId, [plaintext]);
    this.lastDiscoveryAt.set(peerUserId, Date.now());

    const p = (async () => {
      try {
        await this.discoverAndCatchUp(peerUserId, knownDevices);
      } finally {
        this.inflightDiscovery.delete(peerUserId);
        this.pendingCatchUp.delete(peerUserId);
      }
    })();
    this.inflightDiscovery.set(peerUserId, p);
    // Surface unhandled rejection so it doesn't pollute the runtime log;
    // discovery failures are best-effort.
    p.catch(() => {});
  }

  /**
   * Implementation of background catch-up. Strategy:
   *   1. list_devices(peer)            — cheap, no OTK consumption.
   *   2. diff against `knownDevices`   — captured at send time, before
   *                                       any concurrent refresh.
   *   3. if there's anything new      — refreshPeerBundles(peer) to pull
   *      the new device's bundle (and incidentally refresh existing ones).
   *      claim_all consumes OTKs for ALL listed devices; this cost is
   *      paid once per genuine device-set change, not per send.
   *   4. snapshot the catch-up queue THEN clear it. New sends after the
   *      bundleCache refresh fanout to the new device naturally and
   *      shouldn't be caught up again — clearing the queue here is what
   *      prevents double-delivery to the new device.
   *   5. encrypt each queued plaintext for each new device and emit via
   *      onCatchUpEnvelope so the SDK can ship them.
   */
  private async discoverAndCatchUp(
    peerUserId: string,
    knownDevices: ClaimedDevice[],
  ): Promise<void> {
    let live;
    try {
      live = await this.opts.http.listDevices(this.opts.selfDeviceId, peerUserId);
    } catch {
      return; // network blip; next send tries again after the floor
    }

    const known = new Set(knownDevices.map((d) => d.deviceId));
    const newDeviceIds = live.devices
      .filter((d) => !known.has(d.deviceId))
      .filter((d) =>
        !(peerUserId === this.opts.selfUserId && d.deviceId === this.opts.selfDeviceId),
      )
      .map((d) => d.deviceId);

    if (newDeviceIds.length === 0) return;

    // Refresh bundleCache FIRST so post-refresh sends fanout naturally.
    let refreshed: ClaimedDevice[];
    try {
      refreshed = await this.refreshPeerBundles(peerUserId);
    } catch {
      return;
    }

    // Snapshot + clear the queue. Anything that lands in pendingCatchUp
    // AFTER this point will be dropped on the `finally` cleanup — but
    // those sends already saw the fresh bundleCache and fanned out to
    // the new device naturally, so dropping their queue entries is the
    // right thing (avoids double-encrypt).
    const queue = this.pendingCatchUp.get(peerUserId) ?? [];
    this.pendingCatchUp.set(peerUserId, []);

    const targets = refreshed.filter((d) => newDeviceIds.includes(d.deviceId));
    const emit = this.opts.onCatchUpEnvelope;

    // Drain in original send order — each encrypt advances the new Olm
    // session's ratchet, so the recipient decrypts cleanly when it
    // receives them in this order.
    for (const pt of queue) {
      for (const dev of targets) {
        try {
          const env = await this.encryptForOneDevice(peerUserId, dev, pt);
          emit?.({
            peerUserId,
            peerDeviceId: dev.deviceId,
            ciphertext: env.ciphertext,
            msgType: env.msgType,
          });
        } catch {
          // Per-target best-effort.
        }
      }
    }
  }

  private async encryptForOneDevice(
    peerUserId: string,
    bundle: ClaimedDevice,
    plaintext: string,
  ): Promise<OutboundEnvelope> {
    const lockKey = sessionKey(peerUserId, bundle.deviceId);
    const prev = this.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.locks.set(lockKey, prev.then(() => next));
    await prev;
    try {
      return await this.opts.crypto.encryptForPeer(peerUserId, bundle.deviceId, bundle, plaintext);
    } finally {
      release();
      // GC the lock if we're the last waiter.
      if (this.locks.get(lockKey) === prev.then(() => next)) {
        this.locks.delete(lockKey);
      }
    }
  }
}

function sessionKey(peerUserId: string, peerDeviceId: string): string {
  return `${peerUserId}|${peerDeviceId}`;
}

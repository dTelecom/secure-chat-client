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
    if (devices.length === 0) return [];

    const results: EncryptForResult[] = [];
    for (const dev of devices) {
      const env = await this.encryptForOneDevice(peerUserId, dev, plaintext);
      results.push({ peerDeviceId: dev.deviceId, ciphertext: env.ciphertext, msgType: env.msgType });
    }
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
   */
  async forgetPeerDevice(peerUserId: string, peerDeviceId: string): Promise<void> {
    const cached = this.bundleCache.get(peerUserId);
    if (cached) {
      this.bundleCache.set(
        peerUserId,
        cached.filter((d) => d.deviceId !== peerDeviceId),
      );
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
    if (cached) return cached;
    const inflight = this.inflightRefresh.get(peerUserId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        return await this.refreshPeerBundles(peerUserId);
      } finally {
        this.inflightRefresh.delete(peerUserId);
      }
    })();
    this.inflightRefresh.set(peerUserId, p);
    return p;
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

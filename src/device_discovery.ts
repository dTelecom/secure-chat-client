// PeerDeviceCache — lightweight cache of peer device metadata, refreshed
// lazily on chat-open and on-decrypt-failure. Distinct from SessionManager's
// bundle cache: this just tracks "which devices does B currently have?"
// without consuming OTKs (uses GET /api/chat/keys/list_devices).
//
// Refresh triggers (per plan §17):
//   - On first chat-open with a peer (no cache or stale cache)
//   - On inbound prekey-message from a previously-unknown peer device
//     (handled at the SDK boundary; this layer just provides addPeerDevice)
//   - Optional periodic eager refresh (off by default)

import type { HttpClient } from "./transport/http.js";

export interface PeerDeviceMeta {
  deviceId: string;
  fingerprint: string;
  lastActiveAt: number;
}

export interface PeerDeviceCacheOptions {
  http: HttpClient;
  selfDeviceId: string;
  /** Cache freshness window. Default 5 minutes. */
  staleAfterMs?: number;
}

interface CacheEntry {
  devices: PeerDeviceMeta[];
  fetchedAt: number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export class PeerDeviceCache {
  private cache = new Map<string, CacheEntry>();

  constructor(private opts: PeerDeviceCacheOptions) {}

  /**
   * Return peer's known devices, refreshing if cache is missing or older
   * than `staleAfterMs`.
   */
  async getPeerDevices(peerUserId: string): Promise<PeerDeviceMeta[]> {
    const now = Date.now();
    const stale = this.opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const entry = this.cache.get(peerUserId);
    if (entry && now - entry.fetchedAt < stale) {
      return entry.devices;
    }
    return this.refresh(peerUserId);
  }

  /** Force a fresh fetch regardless of staleness. */
  async refresh(peerUserId: string): Promise<PeerDeviceMeta[]> {
    const res = await this.opts.http.listDevices(this.opts.selfDeviceId, peerUserId);
    const devices = res.devices.map((d) => ({
      deviceId: d.deviceId,
      fingerprint: d.fingerprint,
      lastActiveAt: d.lastActiveAt,
    }));
    this.cache.set(peerUserId, { devices, fetchedAt: Date.now() });
    return devices;
  }

  /**
   * Add a peer device discovered through other channels (e.g., an inbound
   * prekey-message from a device the cache doesn't know about). Doesn't
   * hit the network. Caller is responsible for the (deviceId, fingerprint).
   */
  noteNewPeerDevice(peerUserId: string, device: PeerDeviceMeta): void {
    const entry = this.cache.get(peerUserId);
    if (!entry) {
      this.cache.set(peerUserId, { devices: [device], fetchedAt: Date.now() });
      return;
    }
    if (entry.devices.some((d) => d.deviceId === device.deviceId)) return;
    entry.devices.push(device);
  }

  /** Drop the cached entry; next getPeerDevices will refetch. */
  invalidate(peerUserId: string): void {
    this.cache.delete(peerUserId);
  }

  /** Drop everything. */
  clear(): void {
    this.cache.clear();
  }
}

// Orchestrates account generation + bundle upload + OTK top-up.
// Stateless wrapper around CryptoAdapter + HttpClient.

import type { CryptoAdapter } from "./crypto/interface.js";
import type { HttpClient } from "./transport/http.js";

export const DEFAULT_OTK_COUNT = 100;
export const OTK_TOPUP_WATERMARK = 20;
export const OTK_TOPUP_TARGET = 100;

export interface KeyBundleManagerOptions {
  http: HttpClient;
  crypto: CryptoAdapter;
  deviceId: string;
  /** Initial OTK pool size on first generation. Default 100. */
  initialOtkCount?: number;
}

/**
 * KeyBundleManager handles the device-key lifecycle:
 *   first run  → generate Olm account + 100 OTKs + upload
 *   subsequent → no-op (account persisted; reupload only on demand)
 *   periodic   → top-up OTKs when server count drops below watermark
 */
export class KeyBundleManager {
  constructor(private opts: KeyBundleManagerOptions) {}

  /** In-flight topup promise — coalesces concurrent callers so the
   *  initial connect + onWsState("open") path doesn't double-upload. */
  private inflightTopup: Promise<{ topped: boolean; newCount?: number }> | null = null;

  /**
   * Idempotent. On first call generates a new Olm account and uploads
   * the bundle; on subsequent calls no-ops if the adapter already has
   * an account. Safe to call on every connect.
   */
  async ensureKeyBundle(): Promise<void> {
    await this.opts.crypto.init();
    if (await this.opts.crypto.hasAccount()) {
      return;
    }
    const bundle = await this.opts.crypto.generateAccount(
      this.opts.initialOtkCount ?? DEFAULT_OTK_COUNT,
    );
    await this.opts.http.uploadKeyBundle(this.opts.deviceId, {
      deviceId: this.opts.deviceId,
      identityKeyCurve: bundle.identityKeyCurve,
      identityKeyEd: bundle.identityKeyEd,
      signedPrekey: bundle.signedPrekey,
      signedPrekeySig: bundle.signedPrekeySig,
      fallbackPrekey: bundle.fallbackPrekey,
      fallbackPrekeySig: bundle.fallbackPrekeySig,
      fingerprint: bundle.fingerprint,
      oneTimeKeys: bundle.oneTimeKeys,
    });
  }

  /**
   * Re-upload the existing bundle without generating new keys. Used after
   * backend wipes during testing, or when the SDK detects a registry
   * mismatch.
   */
  async reuploadCurrentBundle(): Promise<void> {
    await this.opts.crypto.init();
    if (!(await this.opts.crypto.hasAccount())) {
      throw new Error("reuploadCurrentBundle: no account; call ensureKeyBundle first");
    }
    const bundle = await this.opts.crypto.getCurrentBundle();
    await this.opts.http.uploadKeyBundle(this.opts.deviceId, {
      deviceId: this.opts.deviceId,
      identityKeyCurve: bundle.identityKeyCurve,
      identityKeyEd: bundle.identityKeyEd,
      signedPrekey: bundle.signedPrekey,
      signedPrekeySig: bundle.signedPrekeySig,
      fallbackPrekey: bundle.fallbackPrekey,
      fallbackPrekeySig: bundle.fallbackPrekeySig,
      fingerprint: bundle.fingerprint,
      oneTimeKeys: bundle.oneTimeKeys,
    });
  }

  /**
   * Top up if the SERVER's OTK count for this device has dropped below
   * the watermark. Generates fresh OTKs and uploads. Idempotent: a no-op
   * if the count is healthy.
   */
  async topUpIfNeeded(): Promise<{ topped: boolean; newCount?: number }> {
    if (this.inflightTopup) return this.inflightTopup;
    const p = (async () => {
      const { count } = await this.opts.http.otkCount(this.opts.deviceId);
      if (count >= OTK_TOPUP_WATERMARK) {
        return { topped: false } as const;
      }
      const need = OTK_TOPUP_TARGET - count;
      const fresh = await this.opts.crypto.generateOneTimeKeys(need);
      const res = await this.opts.http.topupOtks(this.opts.deviceId, fresh);
      return { topped: true as const, newCount: res.currentCount };
    })();
    this.inflightTopup = p;
    try {
      return await p;
    } finally {
      this.inflightTopup = null;
    }
  }
}

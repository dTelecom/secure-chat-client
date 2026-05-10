// CryptoAdapter abstracts the Olm primitives the SDK needs. Two concrete
// implementations: a real one wrapping @matrix-org/olm + IndexedDB
// (`web-adapter.ts`), and an in-memory plaintext-passthrough one for unit
// tests (`fake-adapter.ts`). Same interface, so session-management logic
// can be tested without WASM.

import type { ClaimedDevice } from "../types.js";

/** Public material the SDK uploads via POST /api/chat/keys/upload. */
export interface UploadBundle {
  identityKeyCurve: string;
  identityKeyEd: string;
  signedPrekey: string;
  signedPrekeySig: string;
  fallbackPrekey: string;
  fallbackPrekeySig: string;
  fingerprint: string;
  oneTimeKeys: { id: string; public: string }[];
}

/** Output of CryptoAdapter.encryptForPeer. */
export interface OutboundEnvelope {
  /** base64-encoded Olm ciphertext. */
  ciphertext: string;
  /**
   * "prekey" if this is the first message in a fresh outbound session
   * (consumes one of the recipient's one-time-keys); "normal" once the
   * session has ratcheted at least once.
   */
  msgType: "prekey" | "normal";
}

/**
 * Olm primitives surface. Methods are async because the underlying WASM
 * library is async-loaded and persistence is async (IndexedDB).
 *
 * The adapter owns Olm account + per-(peerUser, peerDevice) session state
 * and persists across restarts. Callers (sessions.ts, key_bundle.ts) are
 * stateless wrappers that orchestrate via this interface.
 */
export interface CryptoAdapter {
  /** Initialize underlying WASM library. Idempotent. */
  init(): Promise<void>;

  /** True if this adapter has a persisted Olm account. */
  hasAccount(): Promise<boolean>;

  /**
   * Generate a new Olm account and return the public bundle to upload.
   * Persists private state. Throws if an account already exists — call
   * hasAccount() first.
   */
  generateAccount(otkCount: number): Promise<UploadBundle>;

  /**
   * Re-emit the current bundle without generating new keys. Used when
   * the device id is already known but the server doesn't yet have the
   * bundle (e.g. backend was wiped during testing).
   */
  getCurrentBundle(): Promise<UploadBundle>;

  /** Generate N more one-time keys for top-up. Returns public material. */
  generateOneTimeKeys(n: number): Promise<{ id: string; public: string }[]>;

  /**
   * Locally tracked count of unconsumed one-time keys. The server's count
   * is authoritative; this is the SDK's view (decrements on every
   * outbound prekey-message it knows about, but the server may consume
   * OTKs without notifying the SDK).
   */
  unusedOneTimeKeyCount(): Promise<number>;

  /**
   * Encrypt for a peer device. Creates an outbound Olm session lazily
   * from peerBundle if no session exists with (peerUserId, peerDeviceId);
   * subsequent calls reuse the established session.
   */
  encryptForPeer(
    peerUserId: string,
    peerDeviceId: string,
    peerBundle: ClaimedDevice,
    plaintext: string,
  ): Promise<OutboundEnvelope>;

  /**
   * Decrypt an inbound ciphertext. If `msgType === "prekey"` and no
   * session exists yet for (peerUserId, peerDeviceId), creates an
   * inbound session from the prekey message.
   */
  decryptFromPeer(
    peerUserId: string,
    peerDeviceId: string,
    ciphertext: string,
    msgType: "prekey" | "normal",
  ): Promise<string>;

  /** Drop the session with a peer device. Used for explicit reset. */
  forgetSession(peerUserId: string, peerDeviceId: string): Promise<void>;

  /** Whether a session exists with this peer device. */
  hasSession(peerUserId: string, peerDeviceId: string): Promise<boolean>;
}

// In-memory test-only CryptoAdapter that pretends to do Olm but actually
// just round-trips plaintext (with a marker prefix to verify it went through
// the encrypt/decrypt path). Lets unit tests exercise sessions.ts and
// key_bundle.ts without bundling WASM into the test runner.
//
// SECURITY: never use this in production. Has zero cryptographic value.

import type { CryptoAdapter, OutboundEnvelope, UploadBundle } from "./interface.js";
import type { ClaimedDevice } from "../types.js";

interface FakeAccountState {
  identityKeyCurve: string;
  identityKeyEd: string;
  signedPrekey: string;
  signedPrekeySig: string;
  fallbackPrekey: string;
  fallbackPrekeySig: string;
  fingerprint: string;
  otkPool: { id: string; public: string }[];
}

const PREKEY_MARKER = "FAKEPREKEY:";
const NORMAL_MARKER = "FAKENORMAL:";

export class FakeCryptoAdapter implements CryptoAdapter {
  private account: FakeAccountState | null = null;
  // session existence — keyed "<peerUser>|<peerDevice>"; value irrelevant
  private sessions = new Set<string>();
  private otkCounter = 0;

  async init(): Promise<void> {
    /* no-op for fake */
  }

  async hasAccount(): Promise<boolean> {
    return this.account !== null;
  }

  async generateAccount(otkCount: number): Promise<UploadBundle> {
    if (this.account) throw new Error("account already exists");
    const id = randomB64(32);
    this.account = {
      identityKeyCurve: id,
      identityKeyEd: randomB64(32),
      signedPrekey: randomB64(32),
      signedPrekeySig: randomB64(64),
      fallbackPrekey: randomB64(32),
      fallbackPrekeySig: randomB64(64),
      fingerprint: chunked(id),
      otkPool: this.makeOtks(otkCount),
    };
    return this.snapshot();
  }

  async getCurrentBundle(): Promise<UploadBundle> {
    if (!this.account) throw new Error("no account");
    return this.snapshot();
  }

  async generateOneTimeKeys(n: number): Promise<{ id: string; public: string }[]> {
    if (!this.account) throw new Error("no account");
    const fresh = this.makeOtks(n);
    this.account.otkPool.push(...fresh);
    return fresh;
  }

  async unusedOneTimeKeyCount(): Promise<number> {
    return this.account?.otkPool.length ?? 0;
  }

  async encryptForPeer(
    peerUserId: string,
    peerDeviceId: string,
    _peerBundle: ClaimedDevice,
    plaintext: string,
  ): Promise<OutboundEnvelope> {
    if (!this.account) throw new Error("no account");
    const key = sessionKey(peerUserId, peerDeviceId);
    const isFirst = !this.sessions.has(key);
    this.sessions.add(key);
    const marker = isFirst ? PREKEY_MARKER : NORMAL_MARKER;
    const ciphertext = btoa(marker + plaintext);
    return { ciphertext, msgType: isFirst ? "prekey" : "normal" };
  }

  async decryptFromPeer(
    peerUserId: string,
    peerDeviceId: string,
    ciphertext: string,
    msgType: "prekey" | "normal",
  ): Promise<string> {
    if (!this.account) throw new Error("no account");
    const key = sessionKey(peerUserId, peerDeviceId);
    if (msgType === "prekey") {
      this.sessions.add(key);
    } else if (!this.sessions.has(key)) {
      throw new Error("no session for normal-type ciphertext");
    }
    const decoded = atob(ciphertext);
    const expected = msgType === "prekey" ? PREKEY_MARKER : NORMAL_MARKER;
    if (!decoded.startsWith(expected)) {
      throw new Error(`fake decrypt: expected ${expected} prefix, got ${decoded.slice(0, 16)}`);
    }
    return decoded.slice(expected.length);
  }

  async forgetSession(peerUserId: string, peerDeviceId: string): Promise<void> {
    this.sessions.delete(sessionKey(peerUserId, peerDeviceId));
  }

  clearSessionCache(): void {
    this.sessions.clear();
  }

  async hasSession(peerUserId: string, peerDeviceId: string): Promise<boolean> {
    return this.sessions.has(sessionKey(peerUserId, peerDeviceId));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private snapshot(): UploadBundle {
    if (!this.account) throw new Error("no account");
    const { otkPool, ...rest } = this.account;
    return { ...rest, oneTimeKeys: [...otkPool] };
  }

  private makeOtks(n: number): { id: string; public: string }[] {
    const out: { id: string; public: string }[] = [];
    for (let i = 0; i < n; i++) {
      this.otkCounter++;
      out.push({ id: `fake-otk-${this.otkCounter}`, public: randomB64(32) });
    }
    return out;
  }
}

function sessionKey(peerUserId: string, peerDeviceId: string): string {
  return `${peerUserId}|${peerDeviceId}`;
}

function randomB64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  // base64url, no padding
  return btoa(String.fromCharCode(...buf)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function chunked(b64: string): string {
  // 4-character groups separated by hyphens — visual stand-in for the
  // safety-number fingerprint format the UI eventually displays.
  const hex = b64.slice(0, 32);
  return hex.match(/.{1,4}/g)?.join("-") ?? hex;
}

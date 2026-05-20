// CryptoAdapter wrapping @dtelecom/vodozemac-wasm. State (Olm Account,
// per-peer-device Sessions) is pickled as JSON strings and persisted via
// the supplied KVStore.
//
// Olm wire format is libolm-compatible (vodozemac defaults to SessionConfig
// version 1, the libolm format). Bundles produced here interop with libolm
// peers and vice versa — the wire isn't changing, only the implementation.
//
// Olm doesn't natively distinguish "signed prekey" from the curve25519
// identity key the way Signal Protocol does. To match the wire contract's
// Signal-flavored field set:
//   signedPrekey      = identityKeyCurve
//   signedPrekeySig   = account.sign(identityKeyCurve)
//   fallbackPrekey    = account.fallbackKey().curve25519[<id>]
//   fallbackPrekeySig = account.sign(fallbackPrekey)
// Outbound session creation uses identityKeyCurve + oneTimeKey (or
// fallbackPrekey when the OTK is null).

// `#vodozemac` is a package.json subpath import that resolves to
// `@dtelecom/vodozemac-wasm` on web/node, and to `@dtelecom/vodozemac-rn`
// (UniFFI native bridge) on React Native. The two packages expose an
// identical class shape, so this file stays target-agnostic.
import * as vodozemac from "#vodozemac";
import { Account, Session, type InboundResult } from "#vodozemac";
import { silentLogger, type Logger } from "../logging.js";
import type { ClaimedDevice } from "../types.js";
import type { KVStore } from "../store/interface.js";
import type { CryptoAdapter, OutboundEnvelope, UploadBundle } from "./interface.js";

const OLM_ACCOUNT_KEY = "olm/account";
const OLM_SESSION_PREFIX = "olm/session/";

export interface OlmAdapterOptions {
  store: KVStore;
  /** Optional logger. Silent by default. */
  log?: Logger;
}

// In Node, @dtelecom/vodozemac-wasm's pkg-node target initializes the
// WASM synchronously at module-load via require('fs'). In a browser
// the pkg-web target uses fetch+instantiateStreaming; the user must
// call the package's default export `init()` once. We do it lazily +
// idempotently inside `OlmCryptoAdapter.init()` so callers don't need
// to know which environment they're in. Detect "browser-like" by the
// presence of a default export on the module (only pkg-web has one).
let wasmInitialized: Promise<void> | null = null;
async function ensureWasmReady(): Promise<void> {
  if (wasmInitialized) return wasmInitialized;
  const mod = vodozemac as unknown as { default?: () => Promise<unknown> };
  if (typeof mod.default !== "function") {
    // pkg-node — already initialized at import time.
    wasmInitialized = Promise.resolve();
    return wasmInitialized;
  }
  wasmInitialized = mod.default().then(() => undefined);
  return wasmInitialized;
}

export class OlmCryptoAdapter implements CryptoAdapter {
  private account: Account | null = null;
  private sessions = new Map<string, Session>();
  private log: Logger;

  constructor(private opts: OlmAdapterOptions) {
    this.log = opts.log ?? silentLogger();
  }

  async init(): Promise<void> {
    await ensureWasmReady();
    if (this.account) return;
    const pickled = await this.opts.store.getString(OLM_ACCOUNT_KEY);
    if (pickled) {
      this.account = Account.fromPickle(pickled);
    }
  }

  async hasAccount(): Promise<boolean> {
    return this.account !== null;
  }

  async generateAccount(otkCount: number): Promise<UploadBundle> {
    if (this.account) throw new Error("account already exists");
    const acc = new Account();
    acc.generateOneTimeKeys(otkCount);
    acc.generateFallbackKey();
    this.account = acc;
    const bundle = this.buildBundle(acc);
    acc.markKeysAsPublished();
    await this.persistAccount();
    return bundle;
  }

  async getCurrentBundle(): Promise<UploadBundle> {
    return this.buildBundle(this.requireAccount());
  }

  async generateOneTimeKeys(n: number): Promise<{ id: string; public: string }[]> {
    const acc = this.requireAccount();
    acc.generateOneTimeKeys(n);
    const otks = parseOneTimeKeys(acc.oneTimeKeys());
    acc.markKeysAsPublished();
    await this.persistAccount();
    return otks;
  }

  async unusedOneTimeKeyCount(): Promise<number> {
    const acc = this.requireAccount();
    return parseOneTimeKeys(acc.oneTimeKeys()).length;
  }

  async encryptForPeer(
    peerUserId: string,
    peerDeviceId: string,
    peerBundle: ClaimedDevice,
    plaintext: string,
  ): Promise<OutboundEnvelope> {
    const acc = this.requireAccount();
    let session = await this.loadSession(peerUserId, peerDeviceId);
    const hadSession = !!session;
    if (!session) {
      // Olm needs ONE remote curve25519 key to bootstrap; prefer OTK, fall
      // back to the per-device fallback prekey when the server's OTK pool
      // for that device is empty (oneTimeKey === null).
      const remoteOtk = peerBundle.oneTimeKey?.public ?? peerBundle.fallbackPrekey;
      session = acc.createOutboundSession(peerBundle.identityKeyCurve, remoteOtk);
      this.sessions.set(sessionKey(peerUserId, peerDeviceId), session);
    }
    const out = JSON.parse(session.encrypt(plaintext)) as { type: 0 | 1; body: string };
    await this.persistSession(peerUserId, peerDeviceId, session);
    const msgType = out.type === 0 ? "prekey" : "normal";
    this.log.debug("crypto.encryptForPeer", {
      peerUserId, peerDeviceId, msgType, hadSession,
    });
    return {
      ciphertext: out.body,
      msgType,
    };
  }

  async decryptFromPeer(
    peerUserId: string,
    peerDeviceId: string,
    ciphertext: string,
    msgType: "prekey" | "normal",
  ): Promise<string> {
    const acc = this.requireAccount();
    let session = await this.loadSession(peerUserId, peerDeviceId);
    const isPrekey = msgType === "prekey";
    const hadSession = !!session;

    if (!session) {
      if (!isPrekey) {
        this.log.warn("crypto.decryptFromPeer: no session for normal-type", { peerUserId, peerDeviceId });
        throw new Error(`no session for normal-type ciphertext from ${peerUserId}/${peerDeviceId}`);
      }
      // Inbound bootstrap: vodozemac extracts the sender's identity key
      // from the prekey message itself; createInboundSession both creates
      // the session AND decrypts the initial message in one call.
      try {
        const inbound: InboundResult = acc.createInboundSession(ciphertext);
        session = inbound.takeSession();
        const plaintext = inbound.plaintext;
        await this.persistAccount();
        this.sessions.set(sessionKey(peerUserId, peerDeviceId), session);
        await this.persistSession(peerUserId, peerDeviceId, session);
        this.log.info("crypto.decryptFromPeer: bootstrapped inbound session", {
          peerUserId, peerDeviceId,
        });
        return plaintext;
      } catch (err) {
        this.log.error("crypto.decryptFromPeer: bootstrap failed", {
          peerUserId, peerDeviceId, msgType,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    const olmType = isPrekey ? 0 : 1;
    try {
      const plaintext = session.decrypt(olmType, ciphertext);
      await this.persistSession(peerUserId, peerDeviceId, session);
      this.log.debug("crypto.decryptFromPeer: ok", { peerUserId, peerDeviceId, msgType });
      return plaintext;
    } catch (err) {
      this.log.error("crypto.decryptFromPeer: decrypt failed", {
        peerUserId, peerDeviceId, msgType, hadSession,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async forgetSession(peerUserId: string, peerDeviceId: string): Promise<void> {
    const key = sessionKey(peerUserId, peerDeviceId);
    this.sessions.delete(key);
    await this.opts.store.delete(OLM_SESSION_PREFIX + key);
  }

  async hasSession(peerUserId: string, peerDeviceId: string): Promise<boolean> {
    if (this.sessions.has(sessionKey(peerUserId, peerDeviceId))) return true;
    const persisted = await this.opts.store.getString(
      OLM_SESSION_PREFIX + sessionKey(peerUserId, peerDeviceId),
    );
    return persisted !== null;
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private requireAccount(): Account {
    if (!this.account) throw new Error("no Olm account; call generateAccount() or init()");
    return this.account;
  }

  private buildBundle(acc: Account): UploadBundle {
    const idKeys = JSON.parse(acc.identityKeys()) as { curve25519: string; ed25519: string };
    const otks = parseOneTimeKeys(acc.oneTimeKeys());
    // No separate signed-prekey in Olm: report identity_key_curve self-signed.
    const signedPrekey = idKeys.curve25519;
    const signedPrekeySig = acc.sign(signedPrekey);
    const fallbackParsed = parseOneTimeKeys(acc.fallbackKey());
    const fallbackPrekey = fallbackParsed[0]?.public ?? signedPrekey;
    const fallbackPrekeySig = acc.sign(fallbackPrekey);
    return {
      identityKeyCurve: idKeys.curve25519,
      identityKeyEd: idKeys.ed25519,
      signedPrekey,
      signedPrekeySig,
      fallbackPrekey,
      fallbackPrekeySig,
      fingerprint: formatFingerprint(idKeys.ed25519),
      oneTimeKeys: otks,
    };
  }

  private async persistAccount(): Promise<void> {
    const acc = this.requireAccount();
    await this.opts.store.setString(OLM_ACCOUNT_KEY, acc.pickle());
  }

  private async loadSession(peerUserId: string, peerDeviceId: string): Promise<Session | null> {
    const key = sessionKey(peerUserId, peerDeviceId);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const pickled = await this.opts.store.getString(OLM_SESSION_PREFIX + key);
    if (!pickled) return null;
    const session = Session.fromPickle(pickled);
    this.sessions.set(key, session);
    return session;
  }

  private async persistSession(peerUserId: string, peerDeviceId: string, session: Session): Promise<void> {
    await this.opts.store.setString(
      OLM_SESSION_PREFIX + sessionKey(peerUserId, peerDeviceId),
      session.pickle(),
    );
  }
}

function sessionKey(peerUserId: string, peerDeviceId: string): string {
  return `${peerUserId}|${peerDeviceId}`;
}

function parseOneTimeKeys(json: string): { id: string; public: string }[] {
  const parsed = JSON.parse(json) as { curve25519?: Record<string, string> };
  const out: { id: string; public: string }[] = [];
  for (const [id, pub] of Object.entries(parsed.curve25519 ?? {})) {
    out.push({ id, public: pub });
  }
  return out;
}

function formatFingerprint(ed25519PubB64: string): string {
  const groups = (ed25519PubB64.replace(/[+/=]/g, "").match(/.{1,4}/g) ?? []).slice(0, 12);
  return groups.join("-");
}


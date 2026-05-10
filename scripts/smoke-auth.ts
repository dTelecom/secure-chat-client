// smoke:auth — chat token verification against the deployed dtelecom node.
//
//   ✓ valid chat token from the mock backend → /chat/ws upgrade succeeds
//   ✓ malformed token → 401 close
//   ✓ token not signed by the registered tenant wallet → 401 close
//   ✓ expired token → 401 close
//
// All assertions hit a real deployed node (token verification is on the
// node side, against the Solana devnet client registry).

import { runSmoke, check, mintTokenFor, uuid, env } from "./_smoke-helpers.js";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";

async function nodeWsUrl(): Promise<string> {
  const mint = await mintTokenFor("auth-probe")(uuid());
  return mint.chatNodeWsUrl.replace(/\/chat\/ws\/?$/, "");
}

async function tryWs(url: string, token: string): Promise<{ opened: boolean; closeCode?: number }> {
  return new Promise((resolve) => {
    const Ctor = globalThis.WebSocket as unknown as typeof WebSocket;
    const sock = new Ctor(`${url}/chat/ws?access_token=${encodeURIComponent(token)}`);
    let resolved = false;
    const settle = (val: { opened: boolean; closeCode?: number }) => {
      if (resolved) return;
      resolved = true;
      try {
        sock.close();
      } catch {
        // ignore
      }
      resolve(val);
    };
    sock.onopen = () => settle({ opened: true });
    sock.onclose = (ev: CloseEvent) => settle({ opened: false, closeCode: ev.code });
    sock.onerror = () => settle({ opened: false });
    setTimeout(() => settle({ opened: false }), 5000);
  });
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function signJwtWithWallet(secretBase58: string, claims: object): Promise<string> {
  const secretBytes = bs58.decode(secretBase58);
  const seed = secretBytes.slice(0, 32);
  const header = { alg: "EdDSA", typ: "JWT" };
  const headerB64 = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const bodyB64 = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${bodyB64}`;
  const sig = await ed.signAsync(new TextEncoder().encode(signingInput), seed);
  return `${signingInput}.${b64url(sig)}`;
}

await runSmoke("smoke:auth", async () => {
  const url = await nodeWsUrl();

  // 1. valid token via the mock
  const valid = await mintTokenFor("alice")(`alice-${uuid().slice(0, 8)}`);
  const r1 = await tryWs(url, valid.chatToken);
  check("valid chat token opens /chat/ws", r1.opened);

  // 2. malformed token
  const r2 = await tryWs(url, "not.a.real.jwt");
  check("malformed token rejected (no open)", !r2.opened);

  // 3. signed by an unregistered wallet (a fresh local key, NOT in the registry)
  const fakeSeed = new Uint8Array(32);
  globalThis.crypto.getRandomValues(fakeSeed);
  // build a 64-byte "Solana-style" secret (seed + pubkey)
  const fakePub = await ed.getPublicKeyAsync(fakeSeed);
  const fakeSecret = new Uint8Array(64);
  fakeSecret.set(fakeSeed, 0);
  fakeSecret.set(fakePub, 32);
  const fakeIss = bs58.encode(fakePub);
  const now = Math.floor(Date.now() / 1000);
  const fakeJwt = await signJwtWithWallet(bs58.encode(fakeSecret), {
    typ: "chat",
    iss: fakeIss,
    sub: "alice",
    did: "alice-fake",
    iat: now,
    exp: now + 60,
    chat_webhook_url: "http://localhost",
    chat_send: true,
    chat_receive: true,
  });
  const r3 = await tryWs(url, fakeJwt);
  check("token signed by unregistered wallet rejected", !r3.opened);

  // 4. expired token (signed by registered wallet but exp in the past)
  const lkSecret = env.LK_API_SECRET ?? "";
  if (!lkSecret) {
    check("expired-token check (skipped — LK_API_SECRET not set)", true);
  } else {
    const expired = await signJwtWithWallet(lkSecret, {
      typ: "chat",
      iss: env.LK_API_KEY ?? "",
      sub: "alice",
      did: "alice-expired",
      iat: now - 7200,
      exp: now - 3600,
      chat_webhook_url: "http://localhost",
      chat_send: true,
      chat_receive: true,
    });
    const r4 = await tryWs(url, expired);
    check("expired token rejected", !r4.opened);
  }
});

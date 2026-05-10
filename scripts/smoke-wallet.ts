// Stage-0 smoke test for the test wallet.
//
// Verifies the test envvars are correctly formed and that we can sign + verify
// a v1 chat-token JWT (per tasks/chat-wire-contract.md §1) using @noble/ed25519
// without hitting Solana. Catches typos in the env file before any integration
// code runs.
//
// Run: npm run smoke:wallet
// Reads from .env.test in the repo root.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";

// noble/ed25519's async API uses Web Crypto's SHA-512, no setup required.

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const envPath = resolve(process.cwd(), ".env.test");
const fileEnv = loadEnvFile(envPath);
const env = { ...fileEnv, ...process.env };

const apiKey = env.LK_API_KEY;
const apiSecret = env.LK_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error(
    `Missing LK_API_KEY or LK_API_SECRET. Copy .env.test.example to .env.test and fill in the test wallet from the shared dMeet test environment.`,
  );
  process.exit(1);
}

const pubKeyBytes = bs58.decode(apiKey);
if (pubKeyBytes.length !== 32) {
  console.error(`LK_API_KEY decodes to ${pubKeyBytes.length} bytes; expected 32.`);
  process.exit(1);
}

const secretBytes = bs58.decode(apiSecret);
if (secretBytes.length !== 64) {
  console.error(
    `LK_API_SECRET decodes to ${secretBytes.length} bytes; expected 64 (Solana convention: 32-byte seed + 32-byte pubkey).`,
  );
  process.exit(1);
}

const seed = secretBytes.slice(0, 32);
const derivedPubKey = await ed.getPublicKeyAsync(seed);

if (!bytesEqual(derivedPubKey, pubKeyBytes)) {
  console.error(
    `Public key derived from LK_API_SECRET does not match LK_API_KEY. ` +
      `derived=${bs58.encode(derivedPubKey)} expected=${apiKey}`,
  );
  process.exit(1);
}

// Build v1 chat-token JWT per chat-wire-contract.md §1.
const now = Math.floor(Date.now() / 1000);
const header = { alg: "EdDSA", typ: "JWT" };
const body = {
  typ: "chat",
  iss: apiKey,
  sub: "smoke-test-user",
  did: "00000000-0000-0000-0000-000000000001",
  iat: now,
  exp: now + 86_400,
  chatWebhookUrl: "https://test.dmeet.org/envelopes",
  chatSend: true,
  chatReceive: true,
};

const headerB64 = b64url(new TextEncoder().encode(JSON.stringify(header)));
const bodyB64 = b64url(new TextEncoder().encode(JSON.stringify(body)));
const signingInput = `${headerB64}.${bodyB64}`;
const signingInputBytes = new TextEncoder().encode(signingInput);

const signature = await ed.signAsync(signingInputBytes, seed);
const sigB64 = b64url(signature);
const jwt = `${signingInput}.${sigB64}`;

const ok = await ed.verifyAsync(signature, signingInputBytes, pubKeyBytes);

if (!ok) {
  console.error("Local Ed25519 verification of self-signed JWT failed.");
  process.exit(1);
}

console.log("Stage-0 wallet smoke test PASSED.");
console.log("  iss        :", apiKey);
console.log("  jwt length :", jwt.length, "chars");
console.log("  jwt prefix :", jwt.slice(0, 60), "...");

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

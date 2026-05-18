// Shared helpers for the Stage D integration smokes. Each smoke is a
// standalone tsx script under scripts/smoke-*.ts; they share these
// conveniences so the actual scenarios stay short and readable.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DTelecomSecureChat, FakeCryptoAdapter, MemoryKVStore } from "../src/index.js";
import { OlmCryptoAdapter } from "../src/crypto/olm-adapter.js";
import { HttpClient } from "../src/transport/http.js";
import { WsClient } from "../src/transport/ws.js";
import type { InboundFrame, MintTokenResponse } from "../src/types.js";

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

const fileEnv = loadEnvFile(resolve(process.cwd(), ".env.test"));
export const env = { ...fileEnv, ...process.env };
export const API_BASE_URL = env.API_BASE_URL ?? "http://localhost:8787";

export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

export async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── token mint helpers ──────────────────────────────────────────────────────

export function mintTokenFor(userId: string) {
  return async (deviceId: string): Promise<MintTokenResponse> => {
    const res = await fetch(`${API_BASE_URL}/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": userId },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) {
      throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as MintTokenResponse;
  };
}

/**
 * fetchHttpBearer for the in-memory mock — re-uses the chat JWT for the
 * Authorization header on HTTP calls. The mock accepts that as a stand-in
 * for the host's session bearer. The deviceId is irrelevant for the mock's
 * auth, so we pass an empty string and just want the JWT.
 *
 * Against the real dmeet-backend a Privy access token would go here instead.
 */
export function bearerForMock(userId: string): () => Promise<string> {
  const mint = mintTokenFor(userId);
  let cached: { token: string; exp: number } | null = null;
  return async () => {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - now > 60) return cached.token;
    const r = await mint("smoke-bearer");
    cached = { token: r.chatToken, exp: r.expiresAt };
    return r.chatToken;
  };
}

// ── Low-level WS client (for wire-level smokes) ─────────────────────────────

export interface RawSide {
  http: HttpClient;
  ws: WsClient;
  inbound: InboundFrame[];
  userId: string;
  deviceId: string;
}

export async function rawConnect(userId: string, deviceId?: string): Promise<RawSide> {
  const dev = deviceId ?? `${userId}-${uuid().slice(0, 8)}`;
  const http = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(userId),
    fetchHttpBearer: bearerForMock(userId),
  });
  const url = await http.getNodeWsUrl(dev);
  const baseUrl = url.replace(/\/chat\/ws\/?$/, "");
  const inbound: InboundFrame[] = [];
  const ws = new WsClient({
    nodeBaseURL: baseUrl,
    getToken: () => http.getToken(dev),
    onFrame: (f) => inbound.push(f),
    reconnect: false,
    pingIntervalMs: 0,
  });
  await ws.connect();
  return { http, ws, inbound, userId, deviceId: dev };
}

// ── High-level SDK connect (for content-level smokes) ───────────────────────

export interface SdkSide {
  sdk: DTelecomSecureChat;
  userId: string;
  deviceId: string;
  store: MemoryKVStore;
}

export async function sdkConnect(
  userId: string,
  opts: { deviceId?: string; useFakeCrypto?: boolean; store?: MemoryKVStore } = {},
): Promise<SdkSide> {
  // The SDK derives its own deviceId from `store` via loadOrCreateDeviceId
  // — passing `deviceId` here only makes a difference when the caller
  // also pre-seeds the store. Returning `sdk.currentDeviceId` ensures
  // callers can reconnect against the same identity.
  const store = opts.store ?? new MemoryKVStore();
  if (opts.deviceId !== undefined && opts.store === undefined) {
    await store.setString("deviceId", opts.deviceId);
  }
  const crypto = opts.useFakeCrypto ? new FakeCryptoAdapter() : new OlmCryptoAdapter({ store });
  const sdk = await DTelecomSecureChat.connect({
    apiBaseURL: API_BASE_URL,
    selfUserId: userId,
    fetchChatToken: mintTokenFor(userId),
    fetchHttpBearer: bearerForMock(userId),
    store,
    crypto,
  });
  return { sdk, userId, deviceId: sdk.currentDeviceId, store };
}

/**
 * Some Stage D smokes verify the offline-fallback POST flow — the deployed
 * dtelecom node fires an HTTP POST to the chat token's `chat_webhook_url`
 * when a target is offline. By default the mock issues tokens with
 * `chat_webhook_url=http://localhost:8787/envelopes`, which the
 * deployed nodes (running on dtel.network) cannot reach. To run those
 * smokes, expose the mock at a publicly-reachable URL (e.g. via ngrok)
 * and set the mock's CHAT_WEBHOOK_URL env var. This helper detects the
 * default localhost case and aborts the smoke with a clear message.
 */
export async function requireReachableWebhook(name: string): Promise<void> {
  // Sniff the URL the mock currently issues by minting a throwaway token.
  const mint = await mintTokenFor("webhook-probe")(uuid());
  // The chat_webhook_url is inside the token claims; decode the JWT body.
  const claims = decodeJwtBody(mint.chatToken) as { chatWebhookUrl?: string };
  const url = claims.chatWebhookUrl ?? "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/)/.test(url)) {
    console.log(
      `\n${name}: SKIPPED — chat_webhook_url is ${url}; the deployed dtelecom\n` +
        `nodes can't reach localhost. Expose the mock publicly (e.g. ngrok)\n` +
        `and re-run with CHAT_WEBHOOK_URL=https://<tunnel>/envelopes\n` +
        `set in the mock's environment.\n`,
    );
    process.exit(0); // not a failure — environment-blocked
  }
}

function decodeJwtBody(jwt: string): unknown {
  const parts = jwt.split(".");
  if (parts.length !== 3) return {};
  const padLen = (4 - (parts[1].length % 4)) % 4;
  const padded = parts[1] + "=".repeat(padLen);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(atob(std));
  } catch {
    return {};
  }
}

// ── Mock state introspection ────────────────────────────────────────────────

export interface MockState {
  devices: number;
  otk_pools: Array<{ key: string; count: number }>;
  envelopes_by_recipient: Array<{ key: string; count: number }>;
  pushes_fired: number;
  push_events: Array<{ user_id: string; device_id: string; envelope_uuid: string; fired_at: number }>;
  blocks: Array<{ blocker: string; blocked: string[] }>;
}

export async function getMockState(): Promise<MockState> {
  const r = await fetch(`${API_BASE_URL}/__test/state`);
  if (!r.ok) throw new Error(`mock /__test/state ${r.status}`);
  return (await r.json()) as MockState;
}

export async function resetMock(): Promise<void> {
  const r = await fetch(`${API_BASE_URL}/__test/reset`, { method: "POST" });
  if (!r.ok) throw new Error(`mock /__test/reset ${r.status}`);
}

// ── Tiny test runner ────────────────────────────────────────────────────────

let failures = 0;
let passes = 0;

export function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

export function summarize(name: string): void {
  const total = passes + failures;
  console.log(`\n${name}: ${passes}/${total} passed`);
  if (failures > 0) {
    process.exit(1);
  }
}

export async function runSmoke(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    summarize(name);
  } catch (e) {
    console.error(`FAILED:`, e);
    process.exit(1);
  }
}

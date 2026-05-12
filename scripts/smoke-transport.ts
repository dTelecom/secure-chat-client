// End-to-end transport smoke test.
//
// Two SDK instances ("alice" and "bob") connect to a real deployed dtelecom
// node's /chat/ws. Each mints its own chat token via secure-chat-mock; the
// mock returns the closest dtelecom node URL alongside the token (computed
// via @dtelecom/server-sdk-js — the same Solana-based discovery the room SDK
// uses). Alice sends an opaque-ciphertext ChatSend targeting Bob's device;
// we verify Bob receives a chatEnvelope frame and Alice gets chatSendResult
// with status=live. No crypto: only validates auth + transport + routing.
//
// Required env (.env.test or process):
//   API_BASE_URL    — secure-chat-mock URL, default http://localhost:8787
//
// Optional, for local dev with a single known node (skips Solana discovery):
//   set CHAT_NODE_WS_URL_OVERRIDE in the mock's environment, not here.
//
// Run:  npm run smoke:transport

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HttpClient } from "../src/transport/http.js";
import { WsClient } from "../src/transport/ws.js";
import type {
  ChatEnvelopeFrame,
  ChatSendResultFrame,
  InboundFrame,
  MintTokenResponse,
} from "../src/types.js";

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
const env = { ...fileEnv, ...process.env };

const API_BASE_URL = env.API_BASE_URL ?? "http://localhost:8787";

console.log(`API_BASE_URL = ${API_BASE_URL}`);
console.log(`(node URL is discovered server-side and returned with the token)`);

function makeFetchToken(userId: string) {
  return async (deviceId: string): Promise<MintTokenResponse> => {
    const res = await fetch(`${API_BASE_URL}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-user": userId,
      },
      body: JSON.stringify({ deviceId: deviceId }),
    });
    if (!res.ok) {
      throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as MintTokenResponse;
  };
}

async function makeSide(userId: string, deviceId: string) {
  const fetchToken = makeFetchToken(userId);
  let cached: { token: string; exp: number } | null = null;
  const fetchHttpBearer = async (): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - now > 60) return cached.token;
    const r = await fetchToken("smoke-transport-bearer");
    cached = { token: r.chatToken, exp: r.expiresAt };
    return r.chatToken;
  };
  const http = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: fetchToken,
    fetchHttpBearer,
  });

  const nodeWsUrl = await http.getNodeWsUrl(deviceId);
  console.log(`[${userId}/${deviceId}] node URL: ${nodeWsUrl}`);
  // The discovered URL may include a path (e.g., wss://host/chat/ws). WsClient
  // appends /chat/ws itself, so strip any trailing /chat/ws if present.
  const baseUrl = nodeWsUrl.replace(/\/chat\/ws\/?$/, "");

  const inbound: InboundFrame[] = [];
  const ws = new WsClient({
    nodeBaseURL: baseUrl,
    getToken: () => http.getToken(deviceId),
    onFrame: (f) => {
      inbound.push(f);
      console.log(`[${userId}/${deviceId}] <- ${JSON.stringify(f)}`);
    },
    onState: (s) => console.log(`[${userId}/${deviceId}] state=${s}`),
    reconnect: false,
    pingIntervalMs: 0,
  });
  await ws.connect();
  return { http, ws, inbound, userId, deviceId };
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

async function waitFor<T>(check: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

async function main() {
  const alice = await makeSide("alice", `alice-${uuid().slice(0, 8)}`);
  const bob = await makeSide("bob", `bob-${uuid().slice(0, 8)}`);

  console.log("both sides connected; sending alice → bob …");

  const envelopeUuid = uuid();
  const ciphertextB64 = Buffer.from("hello over the mesh", "utf8").toString("base64");

  alice.ws.sendChat({
    toUserId: bob.userId,
    targets: [
      {
        deviceId: bob.deviceId,
        ciphertext: ciphertextB64,
        envelopeUuid: envelopeUuid,
      },
    ],
  });

  const recv = await waitFor(
    () =>
      bob.inbound.find(
        (f): f is ChatEnvelopeFrame =>
          f.kind === "chatEnvelope" && f.envelopeUuid === envelopeUuid,
      ),
    10_000,
    `bob to receive envelope ${envelopeUuid}`,
  );
  if (recv.senderUserId !== alice.userId || recv.senderDeviceId !== alice.deviceId) {
    throw new Error(`bob received wrong sender: ${JSON.stringify(recv)}`);
  }
  if (recv.ciphertext !== ciphertextB64) {
    throw new Error(`bob received wrong ciphertext (got ${recv.ciphertext})`);
  }

  const result = await waitFor(
    () =>
      alice.inbound.find(
        (f): f is ChatSendResultFrame =>
          f.kind === "chatSendResult" &&
          f.results.some((r) => r.envelopeUuid === envelopeUuid),
      ),
    10_000,
    "alice to receive chatSendResult",
  );
  const aliceResult = result.results.find((r) => r.envelopeUuid === envelopeUuid)!;
  if (aliceResult.status !== "live") {
    throw new Error(
      `alice expected status=live, got ${aliceResult.status}: ${aliceResult.error ?? "(no error)"}`,
    );
  }

  console.log("PASSED.");
  console.log(`  envelopeUuid : ${envelopeUuid}`);
  console.log(`  decoded text  : ${Buffer.from(recv.ciphertext, "base64").toString("utf8")}`);
  console.log(`  alice status  : ${aliceResult.status}`);

  await alice.ws.close();
  await bob.ws.close();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

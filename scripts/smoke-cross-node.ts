// Cross-node end-to-end transport smoke test.
//
// Forces alice and bob onto DIFFERENT chat-enabled dtelecom nodes (overriding
// the closest-node URL the mock would otherwise return for both) and verifies:
//   - bob receives the chatEnvelope through gossipsub propagation between nodes
//   - alice receives chatSendResult: live (the multiplexed ACK round-trips
//     across two nodes back to alice's envelope-topic subscription)
//
// This proves cross-node mesh delivery on top of the same-node fast path
// the standard smoke test exercises.
//
// Required env (.env.test or process):
//   API_BASE_URL    — secure-chat-mock URL, default http://localhost:8787
//
// Run: npm run smoke:cross-node

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

interface NodeInfo {
  domain: string;
  hasChatWs: boolean;
}

async function pickTwoChatNodes(): Promise<[string, string]> {
  const res = await fetch(`${API_BASE_URL}/__test/nodes`);
  if (!res.ok) {
    throw new Error(`fetching node list failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { nodes: NodeInfo[] };
  const enabled = body.nodes.filter((n) => n.hasChatWs);
  console.log(`mesh has ${body.nodes.length} nodes; ${enabled.length} chat-enabled`);
  for (const n of body.nodes) {
    console.log(`  ${n.hasChatWs ? "✓" : "✗"} ${n.domain}`);
  }
  if (enabled.length < 2) {
    throw new Error(
      `need at least 2 chat-enabled nodes for cross-node test; found ${enabled.length}. ` +
        `Wait for the chat redeploy to roll across more nodes, or run the same-node smoke instead.`,
    );
  }
  // Pick two domains with maximum string distance, just to make sure we don't
  // accidentally pick "the same" via hash collision or duplication.
  const sorted = [...enabled].sort((a, b) => a.domain.localeCompare(b.domain));
  return [`wss://${sorted[0].domain}`, `wss://${sorted[sorted.length - 1].domain}`];
}

function makeFetchToken(userId: string) {
  return async (deviceId: string): Promise<MintTokenResponse> => {
    const res = await fetch(`${API_BASE_URL}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-user": userId,
      },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) {
      throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as MintTokenResponse;
  };
}

async function makeSide(userId: string, deviceId: string, forcedNodeBase: string) {
  const fetchToken = makeFetchToken(userId);
  let cached: { token: string; exp: number } | null = null;
  const fetchHttpBearer = async (): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - now > 60) return cached.token;
    const r = await fetchToken("smoke-cross-node-bearer");
    cached = { token: r.chatToken, exp: r.expiresAt };
    return r.chatToken;
  };
  const http = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: fetchToken,
    fetchHttpBearer,
  });
  // Bypass the closest-node URL the mock would return — connect to whichever
  // node we want to force.
  const inbound: InboundFrame[] = [];
  const ws = new WsClient({
    nodeBaseURL: forcedNodeBase,
    getToken: () => http.getToken(deviceId),
    onFrame: (f) => {
      inbound.push(f);
      console.log(`[${userId}/${deviceId} @ ${forcedNodeBase}] <- ${JSON.stringify(f)}`);
    },
    onState: (s) => console.log(`[${userId}/${deviceId} @ ${forcedNodeBase}] state=${s}`),
    reconnect: false,
    pingIntervalMs: 0,
  });
  await ws.connect();
  return { http, ws, inbound, userId, deviceId, nodeBase: forcedNodeBase };
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

async function waitFor<T>(check: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label} after ${timeoutMs}ms`);
}

async function main() {
  const [aliceNode, bobNode] = await pickTwoChatNodes();
  console.log(`alice → ${aliceNode}`);
  console.log(`bob   → ${bobNode}`);
  if (aliceNode === bobNode) {
    throw new Error("internal: picked same node twice");
  }

  const alice = await makeSide("alice", `alice-${uuid().slice(0, 8)}`, aliceNode);
  const bob = await makeSide("bob", `bob-${uuid().slice(0, 8)}`, bobNode);

  console.log("both sides connected on different nodes; sending alice → bob …");

  // Cross-node delivery is slower than same-node because the gossipsub mesh
  // has to propagate. Give it a longer window.
  const envelopeUuid = uuid();
  const ciphertextB64 = Buffer.from("hello across the mesh", "utf8").toString("base64");

  alice.ws.sendChat({
    toUserId: bob.userId,
    targets: [
      {
        deviceId: bob.deviceId,
        ciphertext: ciphertextB64,
        envelopeUuid,
      },
    ],
  });

  const recv = await waitFor(
    () =>
      bob.inbound.find(
        (f): f is ChatEnvelopeFrame =>
          f.kind === "chatEnvelope" && f.envelopeUuid === envelopeUuid,
      ),
    15_000,
    `bob to receive envelope ${envelopeUuid} via cross-node mesh`,
  );
  if (recv.senderUserId !== alice.userId || recv.senderDeviceId !== alice.deviceId) {
    throw new Error(`bob received wrong sender: ${JSON.stringify(recv)}`);
  }
  if (recv.ciphertext !== ciphertextB64) {
    throw new Error(`bob received wrong ciphertext: got ${recv.ciphertext}`);
  }

  const result = await waitFor(
    () =>
      alice.inbound.find(
        (f): f is ChatSendResultFrame =>
          f.kind === "chatSendResult" &&
          f.results.some((r) => r.envelopeUuid === envelopeUuid),
      ),
    15_000,
    "alice to receive chatSendResult (cross-node ACK)",
  );
  const aliceResult = result.results.find((r) => r.envelopeUuid === envelopeUuid)!;
  if (aliceResult.status !== "live") {
    throw new Error(
      `alice expected status=live, got ${aliceResult.status}: ${aliceResult.error ?? "(no error)"}`,
    );
  }

  console.log("PASSED — cross-node delivery + cross-node ACK both round-trip.");
  console.log(`  alice node    : ${alice.nodeBase}`);
  console.log(`  bob node      : ${bob.nodeBase}`);
  console.log(`  envelopeUuid  : ${envelopeUuid}`);
  console.log(`  decoded text  : ${Buffer.from(recv.ciphertext, "base64").toString("utf8")}`);
  console.log(`  alice status  : ${aliceResult.status}`);

  await alice.ws.close();
  await bob.ws.close();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});

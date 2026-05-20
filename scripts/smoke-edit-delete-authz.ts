// smoke:edit-delete-authz — verifies edit/delete authorization is
// cryptographically bound to the original sender's Olm session.
//
// Two-layer defense:
//   1. Sender-side (since v0.12.0): the SDK's editMessage / deleteMessage
//      throws `not_found` if the message isn't in the local store, and
//      `not_authorized` if it's there but authored by someone else.
//      Smoke check: mallory's SDK refuses to call editMessage(bob, m1)
//      because m1 isn't in mallory's store.
//   2. Receiver-side (defense-in-depth): even if mallory uses a patched
//      SDK or raw transport to ship a forged EditEvent, bob's
//      MessageStore.applyEdit rejects it because the stored row's
//      senderUserId (alice) doesn't match the editor's session-bound
//      identity (mallory).
//
// Approach: alice sends m1 to bob. Mallory (third user) tries to edit
// via her SDK (→ not_found, sender-side defense). Then mallory ships a
// raw forged EditEvent through her own Olm session with bob (→ bob's
// store rejects, receiver-side defense). Same pattern for delete.

import { Account } from "@dtelecom/vodozemac-wasm";
import {
  API_BASE_URL,
  bearerForMock,
  check,
  delay,
  mintTokenFor,
  runSmoke,
  sdkConnect,
  uuid,
  waitFor,
} from "./_smoke-helpers.js";
import { HttpClient } from "../src/transport/http.js";
import { WsClient } from "../src/transport/ws.js";
import { ChatError } from "../src/index.js";
import type { InboundFrame } from "../src/types.js";

// Send an arbitrary content event via raw transport, encrypted from
// `forger` to `target`. Returns once the chatSend frame is dispatched.
async function rawSendForged(
  forgerUserId: string,
  targetUserId: string,
  targetDeviceId: string,
  event: object,
): Promise<void> {
  const forgerDevId = `${forgerUserId}-raw-${uuid().slice(0, 8)}`;
  const http = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(forgerUserId),
    fetchHttpBearer: bearerForMock(forgerUserId, forgerDevId),
  });
  const claim = await http.claimAll(forgerDevId, targetUserId);
  if (claim.devices.length === 0) throw new Error("claim_all returned 0 devices for target");
  // Find target's device matching targetDeviceId (or first one).
  const dev = claim.devices.find((d) => d.deviceId === targetDeviceId) ?? claim.devices[0];
  const forgerAcc = new Account();
  const remoteOtk = dev.oneTimeKey?.public ?? dev.fallbackPrekey;
  const session = forgerAcc.createOutboundSession(dev.identityKeyCurve, remoteOtk);
  const enc = JSON.parse(session.encrypt(JSON.stringify(event))) as { type: 0 | 1; body: string };
  const inbound: InboundFrame[] = [];
  const url = (await http.getNodeWsUrl(forgerDevId)).replace(/\/chat\/ws\/?$/, "");
  const ws = new WsClient({
    nodeBaseURL: url,
    getToken: () => http.getToken(forgerDevId),
    onFrame: (f) => inbound.push(f),
    reconnect: false,
    pingIntervalMs: 0,
  });
  await ws.connect();
  ws.sendChat({
    toUserId: targetUserId,
    msgType: enc.type === 0 ? "prekey" : "normal",
    targets: [{ deviceId: dev.deviceId, ciphertext: enc.body, envelopeUuid: uuid() }],
  });
  await delay(2_000); // let receiver process before we close the ws
  await ws.close();
  void inbound;
}

await runSmoke("smoke:edit-delete-authz", async () => {
  const ts = Date.now();
  const alice = await sdkConnect(`alice-authz-${ts}`);
  const bob = await sdkConnect(`bob-authz-${ts}`);
  const mallory = await sdkConnect(`mallory-authz-${ts}`);

  const bobMessages: Array<{ id: string; text: string; from: string }> = [];
  bob.sdk.on("message", (e) => {
    bobMessages.push({ id: e.message.id, text: e.message.text, from: e.peerUserId });
  });
  let mallEditFired = false;
  let aliceEditFired = false;
  bob.sdk.on("messageEdited", (e) => {
    if (e.peerUserId === alice.userId) aliceEditFired = true;
    else if (e.peerUserId === mallory.userId) mallEditFired = true;
  });

  // Step 1: alice sends m1 to bob.
  const m1 = await alice.sdk.sendText(bob.userId, "the original from alice");
  await waitFor(() => bobMessages.find((m) => m.id === m1), 10_000, "bob to receive alice's message");
  check("bob received alice's message",
    bobMessages.length === 1 && bobMessages[0].text === "the original from alice");

  // Step 2: SENDER-SIDE defense (new in 0.12.0). mallory's editMessage
  // throws not_found because m1 isn't in mallory's local store.
  let mallEditThrew: ChatError | null = null;
  try {
    await mallory.sdk.editMessage(bob.userId, m1, "tampered");
  } catch (e) {
    mallEditThrew = e as ChatError;
  }
  check("sender-side: mallory's editMessage threw", mallEditThrew !== null);
  check("sender-side: error code is not_found",
    mallEditThrew?.code === "not_found");

  // Step 3: RECEIVER-SIDE defense (defense-in-depth). Bypass the SDK
  // and ship a forged EditEvent through raw transport. Bob's store
  // must still reject (the stored row's senderUserId = alice, but the
  // editor's session-bound identity = mallory).
  await rawSendForged(mallory.userId, bob.userId, bob.deviceId, {
    v: 1,
    id: uuid(),
    type: "edit",
    clientSentAt: Date.now(),
    targetId: m1,
    text: "FORGED CONTENT FROM MALLORY",
  });
  check("receiver-side: forged edit did NOT fire messageEdited", !mallEditFired);
  let history = await bob.sdk.getHistory(alice.userId);
  let stored = history.find((m) => m.id === m1);
  check("receiver-side: bob's row still has alice's original",
    stored?.text === "the original from alice",
    `got: ${stored?.text ?? "(missing)"}`);

  // Step 4: Legitimate edit from alice applies.
  await alice.sdk.editMessage(bob.userId, m1, "edited by the real alice");
  await waitFor(() => aliceEditFired || undefined, 10_000, "bob to apply alice's legit edit");
  history = await bob.sdk.getHistory(alice.userId);
  stored = history.find((m) => m.id === m1);
  check("legitimate edit from alice applied", stored?.text === "edited by the real alice");

  // Step 5: SENDER-SIDE delete defense.
  let mallDelThrew: ChatError | null = null;
  try {
    await mallory.sdk.deleteMessage(bob.userId, m1);
  } catch (e) {
    mallDelThrew = e as ChatError;
  }
  check("sender-side: mallory's deleteMessage threw", mallDelThrew !== null);
  check("sender-side: delete error code is not_found",
    mallDelThrew?.code === "not_found");

  // Step 6: RECEIVER-SIDE delete defense. Forged delete via raw transport.
  await rawSendForged(mallory.userId, bob.userId, bob.deviceId, {
    v: 1,
    id: uuid(),
    type: "delete",
    clientSentAt: Date.now(),
    targetId: m1,
  });
  history = await bob.sdk.getHistory(alice.userId);
  stored = history.find((m) => m.id === m1);
  check("receiver-side: forged delete did NOT tombstone alice's message",
    stored?.deletedAt === null && stored?.text === "edited by the real alice",
    `stored=${JSON.stringify(stored)}`);

  await Promise.all([alice.sdk.disconnect(), bob.sdk.disconnect(), mallory.sdk.disconnect()]);
});

// smoke:chat-delete-recreate — the one-shot watermark guard.
//
// Scenario:
//   1. alice → delete-for-everyone(bob). Both sides wiped.
//   2. bob immediately sends "hi" to alice. alice's watermark with bob
//      bumps to the inbound text's clientSentAt.
//   3. A STALE chatDeleteAll (with an older clientSentAt) replayed
//      through a raw transport to alice → alice MUST drop it. The
//      recreated conversation survives.
//
// Without the watermark, the stale delete-all would wipe the new
// conversation — the bug this guard prevents.

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
import type { InboundFrame } from "../src/types.js";

await runSmoke("smoke:chat-delete-recreate", async () => {
  const ts = Date.now();
  const aliceUser = `alice-cdr-${ts}`;
  const bobUser = `bob-cdr-${ts}`;

  const alice = await sdkConnect(aliceUser);
  const bob = await sdkConnect(bobUser);

  // Warmup.
  await alice.sdk.sendText(bobUser, "first");
  await waitFor(async () => {
    const h = await bob.sdk.getHistory(aliceUser, { limit: 10 });
    return h.find((m) => m.text === "first") ? true : undefined;
  }, 5_000, "bob receives first");

  // alice deletes for everyone — establishes a "real" delete-all that's
  // the most recent legitimate one. The watermark on both sides moves to
  // ~now.
  await alice.sdk.deleteConversationForEveryone(bobUser);
  await delay(2_000); // let the delete-all land on bob

  // Record the wall-clock between the legit delete and the recreate so we
  // can build a stale delete-all that's older than the recreate but
  // newer than the legit delete. (Optional sanity — the smoke uses
  // sentinel timestamps below that are guaranteed to be < watermark.)

  // bob sends "hi" — for alice, this is the recreate event that bumps
  // her watermark to the inbound text's clientSentAt.
  let aliceSawNewText = false;
  alice.sdk.on("message", (e) => {
    if (e.peerUserId === bobUser && e.message.text === "hi after delete") aliceSawNewText = true;
  });
  await bob.sdk.sendText(aliceUser, "hi after delete");
  await waitFor(() => (aliceSawNewText ? true : undefined), 5_000, "alice to receive bob's recreate text");
  check("1.1 alice sees bob's recreate text", aliceSawNewText);

  // Now: SHIP a stale chatDeleteAll to alice via raw transport, with a
  // clientSentAt set to 1 (deep in the past, definitely below alice's
  // watermark). Source the send from a raw peer (bob-impostor-dev) so
  // we can construct an arbitrary event. We need a working Olm session
  // with alice to make the wire send decryptable.
  const aliceFromBobBefore = await alice.sdk.getHistory(bobUser, { limit: 10 });
  const conversationsBefore = await alice.sdk.listConversations();
  check("2.1 alice has bob in conv list (post-recreate)",
    conversationsBefore.some((c) => c.peerUserId === bobUser));

  // Build raw Olm send. We use a NEW bob device (impostor) to claim
  // alice's OTKs and forge a chatDeleteAll. The Olm session binding
  // still authenticates as bob (claims for bob-impostor must come from
  // bob's tenant) — for the mock, the x-test-user header is bobUser so
  // the claim ties the ciphertext to senderUserId = bobUser via the
  // chat-token's `sub` claim.
  const bobImpostorDev = `bob-impostor-${uuid().slice(0, 8)}`;
  const http = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(bobUser),
    fetchHttpBearer: bearerForMock(bobUser, bobImpostorDev),
  });
  const claim = await http.claimAll(bobImpostorDev, aliceUser);
  if (claim.devices.length === 0) throw new Error("claim_all returned 0 devices for alice");
  const dev = claim.devices[0];
  const bobAcc = new Account();
  const remoteOtk = dev.oneTimeKey?.public ?? dev.fallbackPrekey;
  const session = bobAcc.createOutboundSession(dev.identityKeyCurve, remoteOtk);

  const stale = {
    v: 1,
    id: uuid(),
    type: "chatDeleteAll",
    clientSentAt: 1, // deep in the past — guaranteed < watermark
  };
  const enc = JSON.parse(session.encrypt(JSON.stringify(stale))) as { type: 0 | 1; body: string };

  const inbound: InboundFrame[] = [];
  const url = (await http.getNodeWsUrl(bobImpostorDev)).replace(/\/chat\/ws\/?$/, "");
  const ws = new WsClient({
    nodeBaseURL: url,
    getToken: () => http.getToken(bobImpostorDev),
    onFrame: (f) => inbound.push(f),
    reconnect: false,
    pingIntervalMs: 0,
  });
  await ws.connect();
  ws.sendChat({
    toUserId: aliceUser,
    msgType: enc.type === 0 ? "prekey" : "normal",
    targets: [{ deviceId: alice.deviceId, ciphertext: enc.body, envelopeUuid: uuid() }],
  });

  // Give alice time to (try to) process and DROP the stale event.
  await delay(3_000);

  // Watermark guard worked: history survives.
  const aliceFromBobAfter = await alice.sdk.getHistory(bobUser, { limit: 10 });
  check("3.1 alice's recreated history survived the stale delete-all replay",
    aliceFromBobAfter.length >= aliceFromBobBefore.length,
    `before=${aliceFromBobBefore.length} after=${aliceFromBobAfter.length}`);
  check("3.2 bob is still in alice's conv list",
    (await alice.sdk.listConversations()).some((c) => c.peerUserId === bobUser));
  check("3.3 'hi after delete' is still in alice's history",
    aliceFromBobAfter.some((m) => m.text === "hi after delete"));

  void inbound;
  await ws.close();
  await alice.sdk.disconnect();
  await bob.sdk.disconnect();
});

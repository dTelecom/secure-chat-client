// smoke:delivery-ack-dedup — verify the SDK's pre-decrypt envelope-uuid
// dedup. The dtelecom node's at-least-once semantics (sender retries
// within fallbackTimeout + one post-webhook republish) means duplicates
// are expected on the wire. Without dedup, the second decrypt fails the
// Olm ratchet (replay rejection), the SDK's existing recovery path
// forgetPeerDevice's the session, and all future messages between the
// pair break.
//
// Strategy: send the SAME envelope (same envelopeUuid + same ciphertext)
// twice in quick succession via a raw WsClient bound to the same Olm
// session. The receiver SDK should:
//   - Fire `message` event ONCE for the first
//   - Drop the second silently (dedup)
//   - Keep the Olm session intact (subsequent fresh send still decrypts)
//
// Runs against any node — does not require the new at-least-once node
// changes since the test produces the duplicate at the wire level.

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

await runSmoke("smoke:delivery-ack-dedup", async () => {
  // Recipient: full SDK so we observe `message` event firing.
  const bob = await sdkConnect(`bob-dedup-${Date.now()}`);
  let messageEvents = 0;
  bob.sdk.on("message", () => {
    messageEvents++;
  });

  // Sender: raw WS + manual Olm session so we control the envelopeUuid
  // and can re-send the SAME ciphertext bytes verbatim. The SDK normally
  // generates a fresh envelopeUuid per send; we need to bypass that.
  const aliceUserId = `alice-dedup-${Date.now()}`;
  const aliceDeviceId = `alice-${uuid().slice(0, 8)}`;
  const http = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(aliceUserId),
    fetchHttpBearer: bearerForMock(aliceUserId, aliceDeviceId),
  });
  const claim = await http.claimAll(aliceDeviceId, bob.userId);
  if (claim.devices.length === 0) throw new Error("claim_all returned 0 devices for bob");
  const dev = claim.devices[0];
  const aliceAcc = new Account();
  const remoteOtk = dev.oneTimeKey?.public ?? dev.fallbackPrekey;
  const session = aliceAcc.createOutboundSession(dev.identityKeyCurve, remoteOtk);

  // Build a valid v=1 text content event the SDK will accept.
  const messageId = uuid();
  const event = {
    v: 1,
    id: messageId,
    type: "text",
    clientSentAt: Date.now(),
    text: "dedup-me",
  };
  const enc = JSON.parse(session.encrypt(JSON.stringify(event))) as { type: 0 | 1; body: string };

  // Bring up alice's WS for sending.
  const inbound: InboundFrame[] = [];
  const url = (await http.getNodeWsUrl(aliceDeviceId)).replace(/\/chat\/ws\/?$/, "");
  const ws = new WsClient({
    nodeBaseURL: url,
    getToken: () => http.getToken(aliceDeviceId),
    onFrame: (f) => inbound.push(f),
    reconnect: false,
    pingIntervalMs: 0,
  });
  await ws.connect();

  // Ship the SAME envelopeUuid + ciphertext TWICE. First send produces
  // a new Olm ratchet step; second send carries the exact same bytes.
  // The receiver's dedup must drop the second WITHOUT going through Olm
  // decrypt (which would fail replay).
  const sharedEnvelopeUuid = uuid();
  ws.sendChat({
    toUserId: bob.userId,
    msgType: enc.type === 0 ? "prekey" : "normal",
    targets: [{ deviceId: bob.deviceId, ciphertext: enc.body, envelopeUuid: sharedEnvelopeUuid }],
  });
  // Wait for the first delivery to land in bob's history.
  await waitFor(async () => {
    const h = await bob.sdk.getHistory(aliceUserId, { limit: 10 });
    return h.some((m) => m.text === "dedup-me") ? true : undefined;
  }, 5_000, "first delivery to land");
  check("1.1 bob received the first envelope as a `message` event", messageEvents === 1,
    `messageEvents=${messageEvents}; expected 1`);

  // Re-send the SAME envelope (same uuid + ciphertext). The node WILL
  // forward it (it doesn't dedupe at the wire layer); the SDK MUST
  // dedupe pre-decrypt or the Olm replay would corrupt the session.
  ws.sendChat({
    toUserId: bob.userId,
    msgType: enc.type === 0 ? "prekey" : "normal",
    targets: [{ deviceId: bob.deviceId, ciphertext: enc.body, envelopeUuid: sharedEnvelopeUuid }],
  });
  // Give the receiver enough time to process the duplicate. If dedup is
  // working, NO additional `message` event fires.
  await delay(2_000);
  check("1.2 duplicate envelope did NOT trigger a second `message` event",
    messageEvents === 1,
    `messageEvents=${messageEvents}; expected 1 (dedup should have suppressed the duplicate)`);

  // Verify the Olm session is still intact: send a FRESH envelope (new
  // uuid + new ciphertext via the next ratchet step) and confirm it
  // decrypts. If the duplicate had corrupted the session via the
  // forgetPeerDevice recovery path, this would fail.
  const event2 = { ...event, id: uuid(), clientSentAt: Date.now(), text: "post-dedup" };
  const enc2 = JSON.parse(session.encrypt(JSON.stringify(event2))) as { type: 0 | 1; body: string };
  ws.sendChat({
    toUserId: bob.userId,
    msgType: enc2.type === 0 ? "prekey" : "normal",
    targets: [{ deviceId: bob.deviceId, ciphertext: enc2.body, envelopeUuid: uuid() }],
  });
  await waitFor(async () => {
    const h = await bob.sdk.getHistory(aliceUserId, { limit: 10 });
    return h.some((m) => m.text === "post-dedup") ? true : undefined;
  }, 5_000, "post-dedup message to land");
  check("1.3 Olm session intact after duplicate — fresh send decrypts",
    messageEvents === 2,
    `messageEvents=${messageEvents}; expected 2 after the fresh send`);

  void inbound;
  await ws.close();
  await bob.sdk.disconnect();
});

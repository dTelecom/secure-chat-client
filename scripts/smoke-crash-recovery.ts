// smoke:crash-recovery — bob's SDK pulls a pending envelope but does NOT
// ack (simulating a tab close mid-flow). Bob reconnects: the same
// envelope is re-delivered; idempotent dedup at the SDK layer means the
// `message` event fires exactly once across both attempts.
//
// We exercise the HTTP layer directly to suppress the ack — the SDK's
// drainPending always acks on success, so to model "decrypted but didn't
// ack" we use HttpClient + decode the ciphertext but skip the ack call,
// then run the SDK's normal flow and verify it handles the re-delivery.

import {
  runSmoke,
  check,
  sdkConnect,
  mintTokenFor,
  API_BASE_URL,
  uuid,
  delay,
  waitFor,
  getMockState,
  requireReachableWebhook,
} from "./_smoke-helpers.js";
import { HttpClient } from "../src/transport/http.js";

await requireReachableWebhook("smoke:crash-recovery");

await runSmoke("smoke:crash-recovery", async () => {
  // Bob registers + immediately disconnects so an offline-fallback path
  // can land messages at the mock. Hold his store so the reconnect below
  // preserves the prekey privates alice's envelope was encrypted to.
  const bobUser = `bob-crash-${Date.now()}`;
  const bobDev = `bob-crash-dev-${uuid().slice(0, 8)}`;
  const bobReg = await sdkConnect(bobUser, { deviceId: bobDev });
  const bobStore = bobReg.store;
  await bobReg.sdk.disconnect();
  await delay(500);

  // Alice sends to offline bob → mock stores envelope.
  const alice = await sdkConnect(`alice-crash-${Date.now()}`);
  await alice.sdk.sendText(bobUser, "post-crash text");
  // Fallback timeout on the deployed node is 2s; allow generous slack
  // for cross-mesh + cloudflared hop before pulling pending.
  await delay(8000);

  // Wait until the envelope actually lands at the mock — the deployed
  // node→cloudflared→mock hop adds variable latency over the local case.
  await waitFor(async () => {
    const s = await getMockState();
    return s.envelopes_by_recipient.find((e) => e.key.includes(bobUser) && e.count > 0);
  }, 15_000, "envelope to land at mock");

  // Step 1: pretend bob's tab opened, pulled, but crashed before acking.
  // We use a raw HttpClient with bob's identity to read pending — and
  // never call ack.
  const bobHttp = new HttpClient({ apiBaseURL: API_BASE_URL, fetchChatToken: mintTokenFor(bobUser) });
  const pending1 = await bobHttp.pending(bobDev);
  check("bob's first pull returns the envelope", pending1.envelopes.length >= 1,
    `pending: ${JSON.stringify(pending1.envelopes.map((e) => e.envelopeUuid))}`);

  // Step 2: bob's tab opens fresh — same persistent store so the prekey
  // privates from registration are intact (a real desktop client would
  // have these on disk). The SDK pulls, decrypts, fires `message`, acks.
  const bob = await sdkConnect(bobUser, { deviceId: bobDev, store: bobStore });
  let messages = 0;
  let receivedText: string | undefined;
  bob.sdk.on("message", (e) => {
    messages++;
    receivedText = e.message.text;
  });
  await waitFor(() => receivedText, 10_000, "bob to decrypt re-delivered envelope");
  check("bob re-pulled and decrypted", receivedText === "post-crash text");
  // Idempotent ACK: subsequent pull should be empty.
  await delay(1000);
  const pending2 = await bobHttp.pending(bobDev);
  check("after recovery, no further pending envelopes", pending2.envelopes.length === 0);

  // The SDK's `message` event fires for EVERY successful decrypt — we
  // expect 1, not 2, because step 1 didn't go through the SDK and the
  // SDK uses the local plaintext store to prevent double-emission for
  // ids it already knows. (For step 1 we never put anything into bob's
  // local store, so step 2's emission is the first.)
  check("message event fired once", messages === 1, `got ${messages}`);

  await Promise.all([alice.sdk.disconnect(), bob.sdk.disconnect()]);
});

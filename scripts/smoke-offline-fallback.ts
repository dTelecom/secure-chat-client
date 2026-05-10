// smoke:offline-fallback — alice sends to bob who has NO live WS. The
// dtelecom node should fall back via webhook to the mock backend, which
// stores the envelope. Bob then connects, drains pending, and the
// message is decrypted.

import {
  runSmoke,
  check,
  sdkConnect,
  getMockState,
  resetMock,
  delay,
  waitFor,
  requireReachableWebhook,
} from "./_smoke-helpers.js";

await requireReachableWebhook("smoke:offline-fallback");

await runSmoke("smoke:offline-fallback", async () => {
  await resetMock();

  // Bob registers + immediately disconnects so claim_all knows him but
  // /chat/ws isn't live anywhere on the mesh. We hold his store so the
  // reconnect below preserves the prekey private keys alice's envelope
  // was encrypted against.
  const bobUserId = `bob-fallback-${Date.now()}`;
  const bobReg = await sdkConnect(bobUserId);
  const bobDeviceId = bobReg.deviceId;
  const bobStore = bobReg.store;
  await bobReg.sdk.disconnect();
  await delay(500);

  const alice = await sdkConnect(`alice-fallback-${Date.now()}`);
  const id = await alice.sdk.sendText(bobUserId, "via the offline path");

  // Wait fallback_timeout (2s) + slack — node should have POSTed the
  // envelope to the mock by now.
  await delay(4_000);

  const state = await getMockState();
  const stored = state.envelopes_by_recipient.find((e) => e.key.includes(bobUserId));
  check("mock has stored envelope for bob", stored !== undefined && stored.count > 0,
    `state: ${JSON.stringify(state.envelopes_by_recipient)}`);

  // Bob reconnects with the SAME device id AND same store (prekey
  // privates intact) — the SDK's drainPending pulls + decrypts.
  const bob = await sdkConnect(bobUserId, { deviceId: bobDeviceId, store: bobStore });
  let receivedText: string | undefined;
  bob.sdk.on("message", (e) => {
    if (e.peerUserId === alice.userId) receivedText = e.message.text;
  });
  await waitFor(() => receivedText, 10_000, "bob to drain pending and decrypt");
  check("bob decrypted the offline-stored message", receivedText === "via the offline path");

  void id;
  await Promise.all([alice.sdk.disconnect(), bob.sdk.disconnect()]);
});

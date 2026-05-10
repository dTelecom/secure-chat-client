// smoke:push-gating — verifies the dtelecom node's mesh-presence query
// computes the correct `push: bool` flag on the offline-fallback POST.
//
//   positive: bob has device-A live + device-B offline, alice sends to
//             both → device-B's fallback POST has push=false (mesh
//             query found A live) → mock pushes_fired counter does NOT
//             increment for device-B.
//   negative: bob has both devices offline → both fallback POSTs have
//             push=true → mock pushes_fired increments by 2.
//
// The mock's "push" is just a test counter (no real APNS/FCM); we read
// /__test/state to inspect.

import {
  runSmoke,
  check,
  sdkConnect,
  getMockState,
  resetMock,
  delay,
  requireReachableWebhook,
} from "./_smoke-helpers.js";

await requireReachableWebhook("smoke:push-gating");

await runSmoke("smoke:push-gating", async () => {
  // ── positive: device-A live, device-B offline ────────────────────────────
  await resetMock();

  const bobUser = `bob-pg-${Date.now()}`;
  const bobOfflineSetup = await sdkConnect(bobUser, { deviceId: "bob-offline-pg" });
  await bobOfflineSetup.sdk.disconnect();
  await delay(500);
  const bobOnline = await sdkConnect(bobUser, { deviceId: "bob-online-pg" });

  const alice1 = await sdkConnect(`alice-pg-${Date.now()}`);
  await alice1.sdk.sendText(bobUser, "with one device live");

  // Wait for fallback decision + push handling to settle.
  await delay(4_000);

  const stateAfterPositive = await getMockState();
  const offlinePushes = stateAfterPositive.push_events.filter((p) => p.device_id === "bob-offline-pg").length;
  check("device-B push suppressed (push=false) when device-A live", offlinePushes === 0,
    `pushes_fired for offline device: ${offlinePushes}`);

  await Promise.all([alice1.sdk.disconnect(), bobOnline.sdk.disconnect()]);

  // ── negative: both bob devices offline ───────────────────────────────────
  await resetMock();

  const bobUser2 = `bob-pg2-${Date.now()}`;
  // register two devices then disconnect both
  const bob1 = await sdkConnect(bobUser2, { deviceId: "bob-1-pg2" });
  const bob2 = await sdkConnect(bobUser2, { deviceId: "bob-2-pg2" });
  await Promise.all([bob1.sdk.disconnect(), bob2.sdk.disconnect()]);
  await delay(500);

  const alice2 = await sdkConnect(`alice-pg2-${Date.now()}`);
  await alice2.sdk.sendText(bobUser2, "neither device live");

  await delay(4_000);
  const stateNegative = await getMockState();
  const totalPushes = stateNegative.pushes_fired;
  // We expect TWO pushes: one for each of bob's devices. Allow >=2 for slack.
  check("both offline devices got push=true (≥2 pushes)", totalPushes >= 2,
    `pushes_fired total: ${totalPushes}`);

  await alice2.sdk.disconnect();
});

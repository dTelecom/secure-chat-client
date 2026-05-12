// smoke:otk-exhaustion — verifies the OTK-pool exhaustion fallback per
// chat-wire-contract.md §2.5. claim_all atomically pops ONE OTK per call.
// When the pool empties, claim_all still returns the device entry — but
// `oneTimeKey: null` — and Olm clients fall through to the long-lived
// `fallbackPrekey` for outbound session establishment.
//
//   step 1: bob registers with the default 100-OTK pool.
//   step 2: drain bob's pool via 100 repeated claim_all calls (raw
//           HTTP — bypasses the SDK's per-peer cache so each call
//           pops one OTK).
//   step 3: confirm /keys/count returns 0.
//   step 4: alice (a fresh SDK instance with no cached session) sends
//           text → her claim_all gets `oneTimeKey: null`, the OlmCrypto
//           adapter falls back to bob's fallbackPrekey for the outbound
//           session, ciphertext travels the mesh, bob decrypts.
//
// Auto-topup (KeyBundleManager.topUpIfNeeded) is currently NOT wired
// into the SDK boot/heartbeat path; this smoke documents that as a
// known gap rather than asserting auto-refill.

import {
  runSmoke, check, sdkConnect, mintTokenFor, bearerForMock,
  API_BASE_URL, resetMock, delay, waitFor,
} from "./_smoke-helpers.js";
import { HttpClient } from "../src/transport/http.js";

await runSmoke("smoke:otk-exhaustion", async () => {
  await resetMock();

  const bobUser = `bob-otk-${Date.now()}`;
  const bob = await sdkConnect(bobUser);

  // ── step 2: drain bob's OTK pool by repeated claim_all from a
  //            "drainer" identity. Each claim pops one OTK atomically.
  const drainerUser = `drainer-${Date.now()}`;
  const drainerHttp = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(drainerUser),
    fetchHttpBearer: bearerForMock(drainerUser),
  });
  // Make the drainer registered (mint a token under its user id so
  // /keys/claim_all auth passes).
  await drainerHttp.getMint("drainer-dev");

  for (let i = 0; i < 100; i++) {
    await drainerHttp.claimAll("drainer-dev", bobUser);
  }

  // ── step 3: confirm pool empty server-side.
  const bobHttp = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(bobUser),
    fetchHttpBearer: bearerForMock(bobUser),
  });
  const count = await bobHttp.otkCount(bob.deviceId);
  check("bob's OTK pool is empty after 100 claims", count.count === 0,
    `count=${count.count}`);

  // ── step 4: alice (fresh) sends → must succeed via fallback prekey.
  const alice = await sdkConnect(`alice-otk-${Date.now()}`);

  // Sanity: drive a separate raw client to inspect the claim response —
  // the SDK's HttpClient is private. The probe also pops one OTK had
  // there been any, so it's keyed by a different user id than alice.
  const probeUser = `alice-otk-probe-${Date.now()}`;
  const aliceProbe = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(probeUser),
    fetchHttpBearer: bearerForMock(probeUser),
  });
  await aliceProbe.getMint("alice-probe-dev");
  const claim = await aliceProbe.claimAll("alice-probe-dev", bobUser);
  const bobEntry = claim.devices.find((d) => d.deviceId === bob.deviceId);
  check("alice's claim returns bob (with no OTK)", bobEntry !== undefined);
  check("oneTimeKey is null on exhausted pool",
    bobEntry !== undefined && bobEntry.oneTimeKey === null,
    `oneTimeKey: ${JSON.stringify(bobEntry?.oneTimeKey)}`);
  check("fallbackPrekey is populated",
    bobEntry !== undefined && typeof bobEntry.fallbackPrekey === "string" && bobEntry.fallbackPrekey.length > 0);

  // Now actually send via the SDK. The SDK's session-establishment
  // path will use the fallbackPrekey because oneTimeKey is null.
  let bobReceived = "";
  bob.sdk.on("message", (e) => {
    if (e.peerUserId === alice.userId) bobReceived = e.message.text ?? "";
  });
  await alice.sdk.sendText(bobUser, "encrypted-via-fallback");
  await waitFor(() => (bobReceived ? bobReceived : undefined),
    8_000, "bob to decrypt fallback-prekey message");
  check("bob decrypted message established via fallback prekey",
    bobReceived === "encrypted-via-fallback",
    `received: ${bobReceived}`);

  // ── auto-topup: bob reconnects → onWsState('open') fires
  //   keyBundle.topUpIfNeeded(), which sees count<watermark and refills
  //   to OTK_TOPUP_TARGET (100). We disconnect+reconnect bob to trigger
  //   it explicitly, since the connect-time topup ran when the pool was
  //   still full (right after registration).
  await bob.sdk.disconnect();
  await delay(500);
  const bob2 = await sdkConnect(bobUser, { deviceId: bob.deviceId, store: bob.store });

  // Allow the fire-and-forget topup to complete.
  await waitFor(async () => {
    const c = await bobHttp.otkCount(bob.deviceId);
    return c.count >= 100 ? c.count : undefined;
  }, 10_000, "bob's OTK pool to refill via auto-topup");

  const countAfterRefill = await bobHttp.otkCount(bob.deviceId);
  check("auto-topup refilled OTK pool to OTK_TOPUP_TARGET on reconnect",
    countAfterRefill.count === 100,
    `count=${countAfterRefill.count}`);

  await Promise.all([alice.sdk.disconnect(), bob2.sdk.disconnect()]);
});

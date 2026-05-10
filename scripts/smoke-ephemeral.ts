// smoke:ephemeral — alice sets typing for bob who has NO live WS.
// The dtelecom node should drop the ephemeral envelope rather than fall
// back to the mock backend. Mock observes ZERO offline-fallback POSTs.

import { runSmoke, check, sdkConnect, getMockState, resetMock, delay } from "./_smoke-helpers.js";

await runSmoke("smoke:ephemeral", async () => {
  await resetMock();

  // Bob registers a key bundle (so claim_all returns a device) but does
  // NOT keep a /chat/ws live — disconnect immediately after registration.
  const bobReg = await sdkConnect("bob-ephemeral");
  const bobUserId = bobReg.userId;
  await bobReg.sdk.disconnect();
  await delay(500);

  const alice = await sdkConnect("alice-ephemeral");
  const before = await getMockState();

  // Setting typing fans out an ephemeral envelope.
  alice.sdk.setTyping(bobUserId, true);

  // Give the node a moment to attempt delivery + decide the fallback path.
  // fallback_timeout default is 2s; ephemeral should drop instead of POST.
  await delay(4_000);

  const after = await getMockState();
  const newEnvelopes =
    after.envelopes_by_recipient.reduce((s, e) => s + e.count, 0) -
    before.envelopes_by_recipient.reduce((s, e) => s + e.count, 0);

  check("zero offline-fallback POSTs for ephemeral envelope", newEnvelopes === 0,
    `mock saw ${newEnvelopes} new envelope(s) after ephemeral send`);

  await alice.sdk.disconnect();
});

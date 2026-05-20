// smoke:chat-delete-self — verify multi-device delete-for-me. alice
// runs two SDK instances (alice-mac + alice-phone, siblings of the
// same selfUserId). alice-mac calls deleteConversationForMe(bob).
// alice-phone receives the selfEcho, wipes its local state too. bob
// is unaffected.

import { check, delay, runSmoke, sdkConnect, waitFor } from "./_smoke-helpers.js";

await runSmoke("smoke:chat-delete-self", async () => {
  const ts = Date.now();
  const aliceUser = `alice-cds-${ts}`;
  const bobUser = `bob-cds-${ts}`;

  const aliceMac = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
  const alicePhone = await sdkConnect(aliceUser, { deviceId: "alice-phone", backgroundDiscoveryFloorMs: 0 });
  const bob = await sdkConnect(bobUser);

  // Establish the conversation on all sides.
  await aliceMac.sdk.sendText(bobUser, "hello from mac");
  await waitFor(async () => {
    const h = await bob.sdk.getHistory(aliceUser, { limit: 10 });
    return h.find((m) => m.text === "hello from mac") ? true : undefined;
  }, 5_000, "bob to receive");
  // alice-phone catches the selfEcho.
  await waitFor(async () => {
    const h = await alicePhone.sdk.getHistory(bobUser, { limit: 10 });
    return h.find((m) => m.text === "hello from mac") ? true : undefined;
  }, 5_000, "alice-phone to receive selfEcho");

  // Sanity: conversation exists everywhere.
  check("0.1 alice-mac has bob in conversation list",
    (await aliceMac.sdk.listConversations()).some((c) => c.peerUserId === bobUser));
  check("0.2 alice-phone has bob in conversation list",
    (await alicePhone.sdk.listConversations()).some((c) => c.peerUserId === bobUser));
  check("0.3 bob has alice in conversation list",
    (await bob.sdk.listConversations()).some((c) => c.peerUserId === aliceUser));

  // alice-mac → delete-for-me.
  let phoneSawDeleteBySelf = false;
  alicePhone.sdk.on("conversationDeletedBySelf", (e) => {
    if (e.peerUserId === bobUser && e.scope === "me") phoneSawDeleteBySelf = true;
  });
  await aliceMac.sdk.deleteConversationForMe(bobUser);

  // alice-mac's view: wiped immediately.
  check("1.1 alice-mac history is empty",
    (await aliceMac.sdk.getHistory(bobUser, { limit: 10 })).length === 0);
  check("1.2 alice-mac conversation list no longer has bob",
    !(await aliceMac.sdk.listConversations()).some((c) => c.peerUserId === bobUser));

  // alice-phone catches the selfEcho and wipes too.
  await waitFor(() => (phoneSawDeleteBySelf ? true : undefined), 6_000, "alice-phone to receive selfEcho");
  check("2.1 alice-phone history is empty after selfEcho",
    (await alicePhone.sdk.getHistory(bobUser, { limit: 10 })).length === 0);
  check("2.2 alice-phone conversation list no longer has bob",
    !(await alicePhone.sdk.listConversations()).some((c) => c.peerUserId === bobUser));
  check("2.3 alice-phone fired conversationDeletedBySelf{scope:'me'}", phoneSawDeleteBySelf);

  // bob is unaffected — chat still on his side.
  await delay(1000); // give any potential wrong-events time to fire
  check("3.1 bob's history still has alice's message",
    (await bob.sdk.getHistory(aliceUser, { limit: 10 })).some((m) => m.text === "hello from mac"));
  check("3.2 bob still has alice in conversation list",
    (await bob.sdk.listConversations()).some((c) => c.peerUserId === aliceUser));

  await aliceMac.sdk.disconnect();
  await alicePhone.sdk.disconnect();
  await bob.sdk.disconnect();
});

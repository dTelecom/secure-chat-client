// smoke:chat-delete-all — verify delete-for-everyone wipes both sides.
// alice has two sibling devices; bob has one. alice-mac calls
// deleteConversationForEveryone. After it completes:
//   - alice-mac, alice-phone, bob ALL have the conversation wiped
//   - bob fires conversationDeletedByPeer

import { check, delay, runSmoke, sdkConnect, waitFor } from "./_smoke-helpers.js";

await runSmoke("smoke:chat-delete-all", async () => {
  const ts = Date.now();
  const aliceUser = `alice-cda-${ts}`;
  const bobUser = `bob-cda-${ts}`;

  const aliceMac = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
  const alicePhone = await sdkConnect(aliceUser, { deviceId: "alice-phone", backgroundDiscoveryFloorMs: 0 });
  const bob = await sdkConnect(bobUser);

  await aliceMac.sdk.sendText(bobUser, "hi from mac");
  await waitFor(async () => {
    const h = await bob.sdk.getHistory(aliceUser, { limit: 10 });
    return h.find((m) => m.text === "hi from mac") ? true : undefined;
  }, 5_000, "bob to receive");
  await waitFor(async () => {
    const h = await alicePhone.sdk.getHistory(bobUser, { limit: 10 });
    return h.find((m) => m.text === "hi from mac") ? true : undefined;
  }, 5_000, "alice-phone selfEcho");
  await delay(500);

  let bobSawPeerDelete = false;
  bob.sdk.on("conversationDeletedByPeer", (e) => {
    if (e.peerUserId === aliceUser) bobSawPeerDelete = true;
  });
  let phoneSawEveryone = false;
  alicePhone.sdk.on("conversationDeletedBySelf", (e) => {
    if (e.peerUserId === bobUser && e.scope === "everyone") phoneSawEveryone = true;
  });

  await aliceMac.sdk.deleteConversationForEveryone(bobUser);

  // alice-mac local view: wiped + event fired locally.
  check("1.1 alice-mac history empty", (await aliceMac.sdk.getHistory(bobUser, { limit: 10 })).length === 0);
  check("1.2 alice-mac conv list no bob",
    !(await aliceMac.sdk.listConversations()).some((c) => c.peerUserId === bobUser));

  // bob receives the chatDeleteAll over the wire.
  await waitFor(() => (bobSawPeerDelete ? true : undefined), 8_000, "bob to receive chatDeleteAll");
  check("2.1 bob fired conversationDeletedByPeer", bobSawPeerDelete);
  check("2.2 bob's history with alice is empty",
    (await bob.sdk.getHistory(aliceUser, { limit: 10 })).length === 0);
  check("2.3 bob's conv list no longer has alice",
    !(await bob.sdk.listConversations()).some((c) => c.peerUserId === aliceUser));

  // alice-phone catches the selfEcho.
  await waitFor(() => (phoneSawEveryone ? true : undefined), 8_000, "alice-phone selfEcho everyone");
  check("3.1 alice-phone fired conversationDeletedBySelf{scope:'everyone'}", phoneSawEveryone);
  check("3.2 alice-phone history is empty",
    (await alicePhone.sdk.getHistory(bobUser, { limit: 10 })).length === 0);

  await aliceMac.sdk.disconnect();
  await alicePhone.sdk.disconnect();
  await bob.sdk.disconnect();
});

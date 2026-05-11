// smoke:conversations — proves chat.listConversations() reflects real
// activity end-to-end against the deployed mesh + tunneled mock.
//
//   step 1: alice ↔ bob exchange; alice ↔ carol exchange.
//   step 2: alice's list = 2 entries, carol first (more recent).
//   step 3: alice marks bob's last message read → unread for bob = 0.
//   step 4: bob sends one more → unread for bob = 1; conversationsChanged
//           fired with bob in the changed array.
//   step 5: alice on a SECOND device — listConversations starts empty
//           (no historical sync); alice sends from device-A → device-B's
//           index gets a row via self-echo.

import { runSmoke, check, sdkConnect, resetMock, delay, waitFor } from "./_smoke-helpers.js";

await runSmoke("smoke:conversations", async () => {
  await resetMock();

  const aliceUser = `alice-conv-${Date.now()}`;
  const bobUser = `bob-conv-${Date.now()}`;
  const carolUser = `carol-conv-${Date.now()}`;

  const aliceA = await sdkConnect(aliceUser, { deviceId: "alice-A" });
  const bob = await sdkConnect(bobUser);
  const carol = await sdkConnect(carolUser);

  // alice → bob
  const bobMsgId = await aliceA.sdk.sendText(bobUser, "hello bob");
  await delay(1_000);
  // bob → alice (1 unread for alice)
  let bobReplyId = "";
  aliceA.sdk.on("message", (e) => {
    if (e.peerUserId === bobUser && !bobReplyId) bobReplyId = e.message.id;
  });
  await bob.sdk.sendText(aliceUser, "hi alice");
  await waitFor(() => (bobReplyId ? bobReplyId : undefined), 8_000, "alice→A to receive bob's reply");

  // alice → carol (newer activity than bob thread)
  await delay(500);
  await aliceA.sdk.sendText(carolUser, "hi carol");
  await delay(1_000);

  // ── step 2: list shows 2 entries, sorted by recency
  let convs = await aliceA.sdk.listConversations();
  check(
    "alice sees 2 conversations after first activity",
    convs.length === 2,
    `len=${convs.length}, peers=${convs.map((c) => c.peerUserId).join(",")}`,
  );
  check(
    "carol is first (more recent than bob thread)",
    convs[0].peerUserId === carolUser,
    `order=${convs.map((c) => c.peerUserId).join(",")}`,
  );

  const bobConv = convs.find((c) => c.peerUserId === bobUser);
  check("alice has 1 unread in bob thread", bobConv?.unreadCount === 1,
    `unread=${bobConv?.unreadCount}`);

  // ── step 3: markRead → unread drops
  await aliceA.sdk.markRead(bobUser, bobReplyId);
  await delay(500);
  convs = await aliceA.sdk.listConversations();
  const bobConv2 = convs.find((c) => c.peerUserId === bobUser);
  check("after markRead, bob unread = 0", bobConv2?.unreadCount === 0,
    `unread=${bobConv2?.unreadCount}`);

  // ── step 4: bob sends again → unread = 1 + conversationsChanged fires
  const changedSeen: string[][] = [];
  aliceA.sdk.on("conversationsChanged", (e) => changedSeen.push(e.changed));
  let bobMsg2Id = "";
  aliceA.sdk.on("message", (e) => {
    if (e.peerUserId === bobUser && e.message.text === "are you there") {
      bobMsg2Id = e.message.id;
    }
  });
  await bob.sdk.sendText(aliceUser, "are you there");
  await waitFor(() => (bobMsg2Id ? bobMsg2Id : undefined), 8_000, "alice to receive bob's second msg");

  convs = await aliceA.sdk.listConversations();
  const bobConv3 = convs.find((c) => c.peerUserId === bobUser);
  check("new bob msg → unread back to 1", bobConv3?.unreadCount === 1,
    `unread=${bobConv3?.unreadCount}`);
  check(
    "conversationsChanged event fired with bob in `changed`",
    changedSeen.some((arr) => arr.includes(bobUser)),
    `events=${JSON.stringify(changedSeen)}`,
  );

  // ── step 5: second alice device starts empty, then sees activity it
  //            originates (self-echo populates the index).
  const aliceB = await sdkConnect(aliceUser, { deviceId: "alice-B" });
  let convsB = await aliceB.sdk.listConversations();
  check("alice-B sees an empty list on first login (no historical sync)",
    convsB.length === 0, `len=${convsB.length}`);

  // Wait for aliceA's bundle cache to refresh and include aliceB before
  // sending — gives the self-echo path enough time to learn the device.
  await delay(2_000);
  await aliceA.sdk.sendText(carolUser, "from device A");

  // alice-B should learn about the carol thread via self-echo of the text.
  await waitFor(
    async () => {
      convsB = await aliceB.sdk.listConversations();
      return convsB.find((c) => c.peerUserId === carolUser) ? true : undefined;
    },
    8_000,
    "alice-B to learn about the carol thread via self-echo",
  );
  check("alice-B sees the carol thread after self-echo",
    convsB.some((c) => c.peerUserId === carolUser),
    `peers=${convsB.map((c) => c.peerUserId).join(",")}`);

  // bobMsgId is only used to anchor the local store; nothing else asserts on it.
  void bobMsgId;

  await Promise.all([
    aliceA.sdk.disconnect(),
    aliceB.sdk.disconnect(),
    bob.sdk.disconnect(),
    carol.sdk.disconnect(),
  ]);
});

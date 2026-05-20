// smoke:edit-window — verify the 24h edit-window enforcement end-to-end
// via the SDK + real Olm + the deployed node.
//
// Three checks:
//   1. Sender-side: editMessage on a freshly-sent message succeeds; bob
//      sees the new text + an editedAt timestamp.
//   2. Sender-side: a hand-crafted "stale" message (seeded directly into
//      the store with sentAt far in the past) makes editMessage throw
//      ChatError("edit_window_expired").
//   3. Receiver-side: alice ships a hand-crafted EditEvent whose
//      clientSentAt is past the window relative to bob's stored sentAt.
//      bob's MessageStore drops the edit (no change to history, no
//      messageEdited event fired).

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
import { ChatError } from "../src/index.js";
import { EDIT_WINDOW_MS } from "../src/content/protocol.js";
import { MessageStore } from "../src/message_store.js";
import { ScopedKVStore } from "../src/store/scoped-adapter.js";
import type { InboundFrame } from "../src/types.js";

await runSmoke("smoke:edit-window", async () => {
  const ts = Date.now();
  const aliceUser = `alice-ew-${ts}`;
  const bobUser = `bob-ew-${ts}`;
  const alice = await sdkConnect(aliceUser);
  const bob = await sdkConnect(bobUser);

  // ── 1. Fresh edit works ───────────────────────────────────────────────
  const m1 = await alice.sdk.sendText(bobUser, "original");
  await waitFor(async () => {
    const h = await bob.sdk.getHistory(aliceUser, { limit: 10 });
    return h.find((m) => m.text === "original") ? true : undefined;
  }, 5_000, "bob to receive original");

  let editedSeen = false;
  bob.sdk.on("messageEdited", (e) => {
    if (e.targetId === m1 && e.newText === "fresh edit") editedSeen = true;
  });
  await alice.sdk.editMessage(bobUser, m1, "fresh edit");
  await waitFor(() => (editedSeen ? true : undefined), 5_000, "bob to see fresh edit");
  const afterEdit = await bob.sdk.getHistory(aliceUser, { limit: 10 });
  const edited = afterEdit.find((m) => m.id === m1)!;
  check("1.1 bob's history has the new text", edited.text === "fresh edit");
  check("1.2 bob's stored row has editedAt set", edited.editedAt !== null);

  // ── 2. Stale message rejected sender-side ─────────────────────────────
  // Seed a fake "stale" message in alice's local store with a sentAt
  // older than EDIT_WINDOW_MS. The SDK's pre-send window check should
  // throw `edit_window_expired` without firing a wire send.
  const scoped = new ScopedKVStore(alice.store, aliceUser);
  const aliceMessages = new MessageStore(scoped);
  const staleId = uuid();
  await aliceMessages.put({
    id: staleId,
    peerUserId: bobUser,
    senderUserId: aliceUser,
    text: "ancient",
    sentAt: Date.now() - EDIT_WINDOW_MS - 60_000, // 1 min past the window
    editedAt: null,
    deletedAt: null,
    status: "sent",
  });

  let threw: ChatError | null = null;
  try {
    await alice.sdk.editMessage(bobUser, staleId, "should fail");
  } catch (e) {
    threw = e as ChatError;
  }
  check("2.1 editMessage threw on stale message", threw !== null);
  check("2.2 error code is edit_window_expired", threw?.code === "edit_window_expired");

  // ── 3. Receiver-side rejection of out-of-window edit ──────────────────
  // Bob has a message from alice with sentAt = (just now via m1). We
  // ship a raw EditEvent through a parallel low-level peer whose
  // clientSentAt is way past the window. Bob's MessageStore.applyEdit
  // must reject and not fire messageEdited.
  //
  // We need a raw send because alice's SDK won't construct an
  // out-of-window edit (her own window check would catch it).
  let outOfWindowEditFired = false;
  bob.sdk.on("messageEdited", (e) => {
    if (e.newText === "out of window") outOfWindowEditFired = true;
  });

  const aliceDevId = `alice-${uuid().slice(0, 8)}`;
  const http = new HttpClient({
    apiBaseURL: API_BASE_URL,
    fetchChatToken: mintTokenFor(aliceUser + "-raw"),
    fetchHttpBearer: bearerForMock(aliceUser + "-raw", aliceDevId),
  });
  const claim = await http.claimAll(aliceDevId, bobUser);
  if (claim.devices.length === 0) throw new Error("claim_all returned 0 devices for bob");
  const dev = claim.devices[0];
  const aliceAcc = new Account();
  const remoteOtk = dev.oneTimeKey?.public ?? dev.fallbackPrekey;
  const session = aliceAcc.createOutboundSession(dev.identityKeyCurve, remoteOtk);

  // EditEvent targeting bob's m1 but with clientSentAt far in the future,
  // making editedAt - sentAt > EDIT_WINDOW_MS.
  const m1Row = (await bob.sdk.getHistory(aliceUser, { limit: 10 })).find((m) => m.id === m1)!;
  const evt = {
    v: 1,
    id: uuid(),
    type: "edit",
    clientSentAt: m1Row.sentAt + EDIT_WINDOW_MS + 60_000,
    targetId: m1,
    text: "out of window",
  };
  const enc = JSON.parse(session.encrypt(JSON.stringify(evt))) as { type: 0 | 1; body: string };
  const inbound: InboundFrame[] = [];
  const url = (await http.getNodeWsUrl(aliceDevId)).replace(/\/chat\/ws\/?$/, "");
  const ws = new WsClient({
    nodeBaseURL: url,
    getToken: () => http.getToken(aliceDevId),
    onFrame: (f) => inbound.push(f),
    reconnect: false,
    pingIntervalMs: 0,
  });
  await ws.connect();
  ws.sendChat({
    toUserId: bobUser,
    msgType: enc.type === 0 ? "prekey" : "normal",
    targets: [{ deviceId: bob.deviceId, ciphertext: enc.body, envelopeUuid: uuid() }],
  });
  // Give the receiver enough time to decrypt + drop.
  await delay(3_000);
  check("3.1 receiver dropped out-of-window edit (no messageEdited fired)",
    !outOfWindowEditFired);
  const stillFreshEdit = await bob.sdk.getHistory(aliceUser, { limit: 10 });
  const checkRow = stillFreshEdit.find((m) => m.id === m1)!;
  check("3.2 receiver's text is still the in-window edit", checkRow.text === "fresh edit");

  void inbound;
  await ws.close();
  await alice.sdk.disconnect();
  await bob.sdk.disconnect();
});

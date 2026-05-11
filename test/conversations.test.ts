// Conversation-index unit tests. Direct tests against ConversationIndex +
// MessageStore — no fake SDK, no Olm. We just want to lock the index's update
// semantics, especially the "out-of-order doesn't rewind" and "self-authored
// messages auto-advance the read watermark" rules.

import { beforeEach, describe, expect, it } from "vitest";

import { ConversationIndex } from "../src/conversations.js";
import { MessageStore, type StoredMessage } from "../src/message_store.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";

const SELF = "alice";

function makeIndex(): { idx: ConversationIndex; msgs: MessageStore; store: MemoryKVStore } {
  const store = new MemoryKVStore();
  const msgs = new MessageStore(store);
  const idx = new ConversationIndex(store, msgs, () => SELF);
  return { idx, msgs, store };
}

async function storeMsg(
  msgs: MessageStore,
  m: Partial<StoredMessage> & Pick<StoredMessage, "id" | "peerUserId" | "senderUserId" | "sentAt">,
): Promise<void> {
  await msgs.put({
    text: "",
    editedAt: null,
    deletedAt: null,
    ...m,
  });
}

describe("ConversationIndex", () => {
  let h: ReturnType<typeof makeIndex>;
  beforeEach(() => {
    h = makeIndex();
  });

  it("starts empty and reports no conversations", async () => {
    expect(await h.idx.list()).toEqual([]);
  });

  it("creates a row on first inbound text and reports unread=1", async () => {
    await storeMsg(h.msgs, { id: "m1", peerUserId: "bob", senderUserId: "bob", sentAt: 100, text: "hi" });
    const changed = await h.idx.onMessageStored({
      peerUserId: "bob",
      senderUserId: "bob",
      messageId: "m1",
      sentAt: 100,
    });
    expect(changed).toBe(true);
    const out = await h.idx.list();
    expect(out).toHaveLength(1);
    expect(out[0].peerUserId).toBe("bob");
    expect(out[0].lastMessageAt).toBe(100);
    expect(out[0].lastMessage?.text).toBe("hi");
    expect(out[0].unreadCount).toBe(1);
  });

  it("self-authored messages count as read (siblings see them already)", async () => {
    await storeMsg(h.msgs, { id: "m1", peerUserId: "bob", senderUserId: SELF, sentAt: 100, text: "hey" });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: SELF, messageId: "m1", sentAt: 100 });
    const out = await h.idx.list();
    expect(out[0].unreadCount).toBe(0);
  });

  it("markReadUpTo clears unread for older peer messages but not newer ones", async () => {
    await storeMsg(h.msgs, { id: "m1", peerUserId: "bob", senderUserId: "bob", sentAt: 100 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m1", sentAt: 100 });
    await storeMsg(h.msgs, { id: "m2", peerUserId: "bob", senderUserId: "bob", sentAt: 200 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m2", sentAt: 200 });
    await storeMsg(h.msgs, { id: "m3", peerUserId: "bob", senderUserId: "bob", sentAt: 300 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m3", sentAt: 300 });

    expect((await h.idx.list())[0].unreadCount).toBe(3);

    const changed = await h.idx.markReadUpTo("bob", 200);
    expect(changed).toBe(true);
    expect((await h.idx.list())[0].unreadCount).toBe(1); // only m3 remains unread
  });

  it("markReadUpTo is idempotent — going backwards is a no-op", async () => {
    await storeMsg(h.msgs, { id: "m1", peerUserId: "bob", senderUserId: "bob", sentAt: 100 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m1", sentAt: 100 });
    expect(await h.idx.markReadUpTo("bob", 500)).toBe(true);
    expect(await h.idx.markReadUpTo("bob", 100)).toBe(false); // backward
    expect(await h.idx.markReadUpTo("bob", 500)).toBe(false); // same
  });

  it("out-of-order delivery doesn't rewind lastMessage", async () => {
    await storeMsg(h.msgs, { id: "m1", peerUserId: "bob", senderUserId: "bob", sentAt: 100 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m1", sentAt: 100 });
    await storeMsg(h.msgs, { id: "m3", peerUserId: "bob", senderUserId: "bob", sentAt: 300 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m3", sentAt: 300 });

    // Late arrival of an older message.
    await storeMsg(h.msgs, { id: "m2", peerUserId: "bob", senderUserId: "bob", sentAt: 200 });
    const changed = await h.idx.onMessageStored({
      peerUserId: "bob",
      senderUserId: "bob",
      messageId: "m2",
      sentAt: 200,
    });
    expect(changed).toBe(false);
    const out = await h.idx.list();
    expect(out[0].lastMessageAt).toBe(300);
    expect(out[0].lastMessage?.id).toBe("m3");
    expect(out[0].unreadCount).toBe(3); // still all three unread
  });

  it("sorts conversations by lastMessageAt DESC", async () => {
    await storeMsg(h.msgs, { id: "b1", peerUserId: "bob", senderUserId: "bob", sentAt: 100 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "b1", sentAt: 100 });
    await storeMsg(h.msgs, { id: "c1", peerUserId: "carol", senderUserId: "carol", sentAt: 200 });
    await h.idx.onMessageStored({ peerUserId: "carol", senderUserId: "carol", messageId: "c1", sentAt: 200 });

    const out = await h.idx.list();
    expect(out.map((c) => c.peerUserId)).toEqual(["carol", "bob"]);
  });

  it("survives reload via load()", async () => {
    await storeMsg(h.msgs, { id: "m1", peerUserId: "bob", senderUserId: "bob", sentAt: 100, text: "hi" });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m1", sentAt: 100 });

    // Fresh index reading from the same store.
    const idx2 = new ConversationIndex(h.store, h.msgs, () => SELF);
    await idx2.load();
    const out = await idx2.list();
    expect(out).toHaveLength(1);
    expect(out[0].peerUserId).toBe("bob");
    expect(out[0].lastMessageAt).toBe(100);
  });

  it("deleted messages don't count toward unread", async () => {
    await storeMsg(h.msgs, { id: "m1", peerUserId: "bob", senderUserId: "bob", sentAt: 100 });
    await h.idx.onMessageStored({ peerUserId: "bob", senderUserId: "bob", messageId: "m1", sentAt: 100 });
    await h.msgs.applyDelete({ targetId: "m1", deleterUserId: "bob", deletedAt: 150 });
    const out = await h.idx.list();
    expect(out[0].unreadCount).toBe(0);
    expect(out[0].lastMessage?.deletedAt).toBe(150);
  });
});

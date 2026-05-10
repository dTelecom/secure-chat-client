// Local message store. Persists user-facing text messages so the UI has a
// historical view, applies edits and tombstones from inbound events, and
// enforces the cryptographic-binding rule for edit/delete (only the
// original sender can mutate a message).
//
// In-memory + KV-backed. Keys are prefixed under "messages/<peerUserId>/<id>".

import type { KVStore } from "./store/interface.js";

/**
 * Persisted shape of a message. `senderUserId` is the truth — the SDK
 * sets it to either "self" (when the local user sent it) or to the
 * peer's user id (on inbound). Edit/delete authorization compares this
 * field on the stored row to the sender of the inbound mutation event.
 */
export interface StoredMessage {
  id: string;
  peerUserId: string;
  senderUserId: string;
  text: string;
  /** Original clientSentAt of the text event; never mutated by edits. */
  sentAt: number;
  /** Set on edit; null otherwise. */
  editedAt: number | null;
  /** Set on delete; the message becomes a tombstone. */
  deletedAt: number | null;
  replyTo?: string;
}

export class MessageStore {
  private cache = new Map<string, StoredMessage>();

  constructor(private store: KVStore) {}

  /** Insert or overwrite. Used for both outbound (self-sent) and inbound. */
  async put(msg: StoredMessage): Promise<void> {
    this.cache.set(msg.id, msg);
    await this.store.setString(this.kvKey(msg.id), JSON.stringify(msg));
  }

  async get(messageId: string): Promise<StoredMessage | null> {
    const cached = this.cache.get(messageId);
    if (cached) return cached;
    const raw = await this.store.getString(this.kvKey(messageId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredMessage;
      this.cache.set(parsed.id, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Return messages for `peerUserId`, oldest→newest within the page.
   *
   * `beforeSentAt` filters to messages with `sentAt < beforeSentAt`, used by
   * the chat UI to load older history above what's already rendered. `limit`
   * caps the page size; when set, the most-recent matches are returned (i.e.
   * the page sits at the boundary just before `beforeSentAt`).
   *
   * v1 implementation walks every persisted message; secondary indexing is
   * a follow-up. For typical chat volumes (hundreds of messages per peer)
   * this is fine; >10k per peer should add a per-peer KV index.
   */
  async listForPeer(
    peerUserId: string,
    opts: { limit?: number; beforeSentAt?: number } = {},
  ): Promise<StoredMessage[]> {
    const keys = await this.store.listKeys("messages/");
    const out: StoredMessage[] = [];
    for (const key of keys) {
      const id = key.slice("messages/".length);
      const cached = this.cache.get(id);
      let msg: StoredMessage | null = cached ?? null;
      if (!msg) {
        const raw = await this.store.getString(key);
        if (!raw) continue;
        try {
          msg = JSON.parse(raw) as StoredMessage;
          this.cache.set(msg.id, msg);
        } catch {
          continue;
        }
      }
      if (msg.peerUserId !== peerUserId) continue;
      if (opts.beforeSentAt !== undefined && msg.sentAt >= opts.beforeSentAt) continue;
      out.push(msg);
    }
    out.sort((a, b) => a.sentAt - b.sentAt);
    if (opts.limit !== undefined && out.length > opts.limit) {
      return out.slice(-opts.limit);
    }
    return out;
  }

  /**
   * Apply an edit if authorized. Returns the resulting message on
   * success, or null if the message doesn't exist, is already deleted,
   * or the editor is not the original sender.
   */
  async applyEdit(opts: {
    targetId: string;
    editorUserId: string;
    newText: string;
    editedAt: number;
  }): Promise<StoredMessage | null> {
    const target = await this.get(opts.targetId);
    if (!target) return null;
    if (target.deletedAt !== null) return null;
    if (target.senderUserId !== opts.editorUserId) return null;
    const updated: StoredMessage = {
      ...target,
      text: opts.newText,
      editedAt: opts.editedAt,
    };
    await this.put(updated);
    return updated;
  }

  /**
   * Apply a delete (tombstone) if authorized. Same authorization rule as
   * edit. Returns the tombstoned message or null.
   */
  async applyDelete(opts: {
    targetId: string;
    deleterUserId: string;
    deletedAt: number;
  }): Promise<StoredMessage | null> {
    const target = await this.get(opts.targetId);
    if (!target) return null;
    if (target.senderUserId !== opts.deleterUserId) return null;
    const updated: StoredMessage = {
      ...target,
      // Purge the original text — the contract is "tombstone, not preserve".
      text: "",
      deletedAt: opts.deletedAt,
    };
    await this.put(updated);
    return updated;
  }

  private kvKey(messageId: string): string {
    return `messages/${messageId}`;
  }
}

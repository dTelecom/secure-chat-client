// Local message store. Persists user-facing text messages so the UI has a
// historical view, applies edits and tombstones from inbound events, and
// enforces the cryptographic-binding rule for edit/delete (only the
// original sender can mutate a message).
//
// In-memory + KV-backed. Keys are prefixed under "messages/<peerUserId>/<id>".

import { EDIT_WINDOW_MS } from "./content/protocol.js";
import type { KVStore } from "./store/interface.js";
import type { MessageStatus } from "./status.js";

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
  /**
   * Set to the edit event's `clientSentAt` when the message has been
   * edited (by the original sender, within the EDIT_WINDOW_MS deadline).
   * Null otherwise. UI: render an "edited" badge when this is non-null.
   * The `text` field reflects the post-edit content; the original is not
   * preserved.
   */
  editedAt: number | null;
  /**
   * Set to the delete event's `clientSentAt` when the message has been
   * tombstoned. The `text` field is wiped to "" on delete; UI: render
   * "this message was deleted" when this is non-null.
   */
  deletedAt: number | null;
  replyTo?: string;
  /** Sender-side delivery status, mirrored from `StatusTracker` so the
   *  last-known state survives reload. `undefined` on inbound messages
   *  (status is the sender's view; it doesn't apply to messages we
   *  received). For outbound: starts at `"pending"`, advances to
   *  `"sent"` → `"delivered"` → `"deliveredAll"` → `"read"`. Terminal
   *  `"failed"` is set when the outbox gives up after max retries. */
  status?: MessageStatus;
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
   * success, or null if:
   *   - the message doesn't exist
   *   - the message is already tombstoned
   *   - the editor is not the original sender
   *   - the edit is past the EDIT_WINDOW_MS deadline (`editedAt` is the
   *     sender's clientSentAt for the edit event; we compare against
   *     the original's `sentAt`, NOT the receiver's wall clock — that
   *     way a misconfigured sender can't sneak past us by setting
   *     `editedAt = original.sentAt`).
   *
   * `originalSentAt` is required so callers don't have to pre-fetch
   * the target row (we do it anyway, but the explicit param documents
   * the contract). Falls back to `target.sentAt` from the fetched row
   * if undefined.
   */
  async applyEdit(opts: {
    targetId: string;
    editorUserId: string;
    newText: string;
    editedAt: number;
    /** Optional: the sender's clientSentAt of the ORIGINAL message.
     *  Provided by the SDK sender path; receiver path lets it default
     *  to the stored row's sentAt. */
    originalSentAt?: number;
  }): Promise<StoredMessage | null> {
    const target = await this.get(opts.targetId);
    if (!target) return null;
    if (target.deletedAt !== null) return null;
    if (target.senderUserId !== opts.editorUserId) return null;
    const baseSentAt = opts.originalSentAt ?? target.sentAt;
    if (opts.editedAt - baseSentAt > EDIT_WINDOW_MS) return null;
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

  /**
   * Drop every message stored for `peerUserId` — KV rows AND in-memory
   * cache, so subsequent `get`/`listForPeer` calls return nothing. Used
   * by `chat.deleteConversationFor{Me,Everyone}` for the "remove from
   * list" UX.
   */
  async deleteForPeer(peerUserId: string): Promise<void> {
    const msgs = await this.listForPeer(peerUserId);
    for (const m of msgs) {
      this.cache.delete(m.id);
      await this.store.delete(this.kvKey(m.id));
    }
  }

  // ── per-peer chat-delete watermark ──────────────────────────────────────
  //
  // The watermark is the `clientSentAt` of the most recent delete event
  // (or local recreate-via-send) honored for this peer. A `chatDeleteAll`
  // arriving with `clientSentAt <= watermark` is silently dropped: this
  // protects a freshly-recreated conversation from being wiped by a
  // stale delete event replayed from `/envelopes/pending` or the node's
  // post-webhook publish.

  async getDeleteWatermark(peerUserId: string): Promise<number> {
    const raw = await this.store.getString(this.watermarkKey(peerUserId));
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  async setDeleteWatermark(peerUserId: string, ms: number): Promise<void> {
    await this.store.setString(this.watermarkKey(peerUserId), String(ms));
  }

  private kvKey(messageId: string): string {
    return `messages/${messageId}`;
  }

  private watermarkKey(peerUserId: string): string {
    return `chatDeleteWatermark/${peerUserId}`;
  }
}

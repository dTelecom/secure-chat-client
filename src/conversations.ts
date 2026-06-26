// Per-peer conversation index. Derived from MessageStore; persisted as small
// rows under `convindex/<peerUserId>` so the chat tab can render a list of
// threads without scanning every stored message on every render. Updated
// idempotently by the SDK as messages are sent, received, edited, or marked
// read.
//
// Two fields drive UX:
//   - lastMessageAt: most recent activity in the thread (any sender). Sorts
//     the list.
//   - lastReadFromPeerAt: sentAt watermark of the last message the LOCAL user
//     has marked read. Unread count = peer-authored messages with
//     sentAt > lastReadFromPeerAt. Synced across own devices because
//     `markRead` self-echoes (see index.ts `dispatchInboundEvent` `selfEcho`
//     `read` branch).
//
// The store is intentionally minimal — no snippet/text denormalization. The
// frontend reads the latest message body via MessageStore.get(lastMessageId)
// so an edit on the lastMessage auto-reflects on next list() without us
// having to keep two sources of truth.

import type { KVStore } from "./store/interface.js";
import type { MessageStore } from "./message_store.js";
import type { MessageStatus } from "./status.js";

const KEY_PREFIX = "convindex/";

const kvKey = (peerUserId: string) => `${KEY_PREFIX}${peerUserId}`;

/** Persisted shape — one row per peer. */
interface ConvIndexRow {
  peerUserId: string;
  lastMessageAt: number;
  lastMessageId: string;
  /** sentAt of the latest message the local user has marked read. 0 means
   *  "never read anything from this peer" — entire thread is unread. */
  lastReadFromPeerAt: number;
}

/** Public shape returned by `chat.listConversations()`. */
export interface Conversation {
  peerUserId: string;
  lastMessageAt: number;
  /** Snapshot of the latest message in the thread. null only if the row
   *  somehow points at a missing MessageStore entry (shouldn't happen). */
  lastMessage: {
    id: string;
    senderUserId: string;
    text: string;
    editedAt: number | null;
    deletedAt: number | null;
    /** Sender-side delivery status for self-authored messages — drives
     *  list-row indicators like "✓✓" / "read". `undefined` on peer-
     *  authored messages (status only exists for messages we sent). */
    status?: MessageStatus;
  } | null;
  /** Count of peer-authored, undeleted messages with sentAt > lastReadFromPeerAt. */
  unreadCount: number;
}

export class ConversationIndex {
  private cache = new Map<string, ConvIndexRow>();
  private loaded = false;

  constructor(
    private store: KVStore,
    private messages: MessageStore,
    private selfUserIdFn: () => string | null,
  ) {}

  /**
   * Bulk-load the index from KV. Idempotent. Called from `connect()` so the
   * frontend's first `listConversations()` is sync against the cache.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    const keys = await this.store.listKeys(KEY_PREFIX);
    for (const k of keys) {
      const raw = await this.store.getString(k);
      if (!raw) continue;
      try {
        const row = JSON.parse(raw) as ConvIndexRow;
        if (typeof row.peerUserId === "string") {
          this.cache.set(row.peerUserId, row);
        }
      } catch {
        // skip malformed
      }
    }
    this.loaded = true;
  }

  /**
   * Called whenever a new or self-echoed text message is stored. Idempotent:
   * if the incoming message is older than the row's current lastMessageAt,
   * the row is left alone so out-of-order delivery doesn't rewind the
   * thread.
   *
   * For self-authored messages (senderUserId === selfUserId) this also
   * advances `lastReadFromPeerAt` to the message's sentAt — the user
   * obviously read what they just sent, and otherwise the unread count
   * would mis-count those rows on a sibling device.
   *
   * Returns true if the row actually changed (so the caller can emit
   * `conversationsChanged` only on meaningful updates).
   */
  async onMessageStored(opts: {
    peerUserId: string;
    senderUserId: string;
    messageId: string;
    sentAt: number;
  }): Promise<boolean> {
    const self = this.selfUserIdFn();
    const existing = this.cache.get(opts.peerUserId);

    const isSelfAuthored = self !== null && opts.senderUserId === self;

    let next: ConvIndexRow;
    if (!existing) {
      next = {
        peerUserId: opts.peerUserId,
        lastMessageAt: opts.sentAt,
        lastMessageId: opts.messageId,
        lastReadFromPeerAt: isSelfAuthored ? opts.sentAt : 0,
      };
    } else {
      // Skip rewind on out-of-order delivery.
      if (opts.sentAt < existing.lastMessageAt && opts.messageId !== existing.lastMessageId) {
        // For self-authored, still possibly bump the read watermark.
        if (isSelfAuthored && opts.sentAt > existing.lastReadFromPeerAt) {
          next = { ...existing, lastReadFromPeerAt: opts.sentAt };
        } else {
          return false;
        }
      } else {
        next = {
          ...existing,
          lastMessageAt: opts.sentAt,
          lastMessageId: opts.messageId,
          lastReadFromPeerAt: isSelfAuthored
            ? Math.max(existing.lastReadFromPeerAt, opts.sentAt)
            : existing.lastReadFromPeerAt,
        };
      }
    }

    if (
      existing &&
      existing.lastMessageAt === next.lastMessageAt &&
      existing.lastMessageId === next.lastMessageId &&
      existing.lastReadFromPeerAt === next.lastReadFromPeerAt
    ) {
      return false;
    }

    this.cache.set(opts.peerUserId, next);
    await this.store.setString(kvKey(opts.peerUserId), JSON.stringify(next));
    return true;
  }

  /**
   * Advance the read watermark for `peerUserId` to `upToSentAt`. Idempotent
   * — going backwards is a no-op. Called from both the outbound markRead
   * path and from the inbound self-echoed `read` handler so siblings stay
   * in sync.
   */
  async markReadUpTo(peerUserId: string, upToSentAt: number): Promise<boolean> {
    const existing = this.cache.get(peerUserId);
    if (!existing) {
      // No conversation row yet (nothing stored from this peer): record a
      // forward watermark so once messages arrive, unread starts at zero.
      const row: ConvIndexRow = {
        peerUserId,
        lastMessageAt: 0,
        lastMessageId: "",
        lastReadFromPeerAt: upToSentAt,
      };
      this.cache.set(peerUserId, row);
      await this.store.setString(kvKey(peerUserId), JSON.stringify(row));
      return true;
    }
    if (upToSentAt <= existing.lastReadFromPeerAt) return false;
    const next = { ...existing, lastReadFromPeerAt: upToSentAt };
    this.cache.set(peerUserId, next);
    await this.store.setString(kvKey(peerUserId), JSON.stringify(next));
    return true;
  }

  /**
   * Return all conversations, sorted by lastMessageAt DESC (most recent
   * first). Joins each row with the latest message snapshot from
   * MessageStore and computes the unread count.
   *
   * Rows that haven't seen a real message yet (lastMessageId === "") are
   * suppressed — those are pure read-watermark placeholders.
   */
  async list(): Promise<Conversation[]> {
    if (!this.loaded) await this.load();
    const self = this.selfUserIdFn();
    const out: Conversation[] = [];
    for (const row of this.cache.values()) {
      if (!row.lastMessageId) continue;
      const last = await this.messages.get(row.lastMessageId);
      let unreadCount = 0;
      if (self) {
        // O(n_messages_for_peer) — fine for typical chat volumes.
        const peerMsgs = await this.messages.listForPeer(row.peerUserId);
        for (const m of peerMsgs) {
          if (m.senderUserId === self) continue;
          if (m.deletedAt !== null) continue;
          if (m.sentAt <= row.lastReadFromPeerAt) continue;
          unreadCount++;
        }
      }
      out.push({
        peerUserId: row.peerUserId,
        lastMessageAt: row.lastMessageAt,
        lastMessage: last
          ? {
              id: last.id,
              senderUserId: last.senderUserId,
              text: last.text,
              editedAt: last.editedAt,
              deletedAt: last.deletedAt,
              status: last.status,
            }
          : null,
        unreadCount,
      });
    }
    out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return out;
  }

  /**
   * Force a full re-read from KV. Resets the `loaded` flag and re-loads all
   * rows. Called on primary-tab promotion so the promoted tab sees
   * conversations another tab of the same device persisted while we were
   * secondary.
   */
  async reload(): Promise<void> {
    this.cache.clear();
    this.loaded = false;
    await this.load();
  }

  /** Peer user IDs currently in the cache (e.g. to emit conversationsChanged
   *  after a reload). */
  peers(): string[] {
    return Array.from(this.cache.keys());
  }

  /** Test/internal accessor — returns the raw cached row. */
  peek(peerUserId: string): ConvIndexRow | undefined {
    return this.cache.get(peerUserId);
  }

  /** Sum of `unreadCount` across every conversation. Computed by delegating
   *  to `list()` so we stay in lockstep with whatever the public view shows.
   *  O(n_messages) for now; cache later if it becomes a hot path. */
  async totalUnread(): Promise<number> {
    const list = await this.list();
    let total = 0;
    for (const c of list) total += c.unreadCount;
    return total;
  }

  /**
   * Drop the conversation row for `peerUserId` — both KV and in-memory
   * cache. Used by `chat.deleteConversation`.
   */
  async delete(peerUserId: string): Promise<void> {
    this.cache.delete(peerUserId);
    await this.store.delete(kvKey(peerUserId));
  }
}

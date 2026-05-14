// Content protocol — events that travel inside the Olm ciphertext. Server
// cannot read or enforce any of this; correctness is enforced
// cryptographically by the Olm session binding (sender identity is fixed
// per session and can't be spoofed without the wallet).
//
// Forward-compat rule: any unknown `type` or `v` higher than this client
// understands is silently dropped (logged at debug). Adding new event
// types is a non-breaking change as long as receivers tolerate them.

import { generateUUID } from "../device.js";

export const CONTENT_PROTOCOL_VERSION = 1;

/** Common header on every content event. */
interface BaseEvent {
  v: 1;
  /** Client-generated UUID — referenced later by edit/delete/replyTo. */
  id: string;
  /** Sender wall-clock at compose time, ms epoch. Receivers SHOULD NOT
   *  trust for ordering — used for display only. */
  clientSentAt: number;
}

export interface TextEvent extends BaseEvent {
  type: "text";
  text: string;
  /** id of message this is a reply to; not validated against existence. */
  replyTo?: string;
}

export interface EditEvent extends BaseEvent {
  type: "edit";
  /** id of the message being edited. Receiver validates the original is
   *  from the same sender (Olm-session-bound) before applying. */
  targetId: string;
  text: string;
}

export interface DeleteEvent extends BaseEvent {
  type: "delete";
  targetId: string;
}

/** Read-watermark: covers all messages in this conversation up to and
 *  including upToId. Cheaper than per-message receipts. */
export interface ReadEvent extends BaseEvent {
  type: "read";
  upToId: string;
}

/** Auto-emitted by the receiver after successful decrypt+store. Batched
 *  upstream of the SDK boundary (see status tracker). */
export interface ReceivedEvent extends BaseEvent {
  type: "received";
  ids: string[];
}

/** Ephemeral typing indicator. Sent with wire-level ephemeral=true so the
 *  node drops on offline-fallback — never persisted. */
export interface TypingEvent extends BaseEvent {
  type: "typing";
  state: "started" | "stopped";
}

/** Multi-device self-echo (Signal "sync messages"). Sent by the originator
 *  to its own user (filtered: not back to the sender's own device) so the
 *  user's other devices observe outbound traffic from this device. The
 *  receiver validates `peerUserId === selfUserId` before unwrapping —
 *  the Olm session binding means only this user's authentic devices can
 *  produce a ciphertext that decrypts under our self-keyed inbound state. */
export type SelfEchoableEvent = TextEvent | EditEvent | DeleteEvent | ReadEvent;
export interface SelfEchoEvent extends BaseEvent {
  type: "selfEcho";
  originalPeer: string;
  original: SelfEchoableEvent;
}

export type ContentEvent =
  | TextEvent
  | EditEvent
  | DeleteEvent
  | ReadEvent
  | ReceivedEvent
  | TypingEvent
  | SelfEchoEvent;

export type ContentEventType = ContentEvent["type"];

// ── encode/decode ───────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Serialize a content event for encryption. Throws on malformed input —
 * this is a code error, not a runtime decision (event is constructed by
 * the SDK, not received from elsewhere).
 */
export function encodeEvent(event: ContentEvent): string {
  if (event.v !== CONTENT_PROTOCOL_VERSION) {
    throw new Error(`encodeEvent: bad version ${event.v}`);
  }
  if (!event.id || !event.type) {
    throw new Error("encodeEvent: missing id or type");
  }
  return JSON.stringify(event);
}

/**
 * Parse a decrypted plaintext as a content event. Returns null for any
 * unsupported version or unknown type — the SDK should silently drop. The
 * forward-compat contract is "unknown future events vanish, never crash."
 *
 * This is forgiving by design: malformed JSON, missing required fields,
 * etc. all return null with a debug log opportunity for the caller.
 */
export function decodeEvent(plaintext: string): ContentEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.v !== "number" || obj.v > CONTENT_PROTOCOL_VERSION) return null;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.type !== "string") return null;
  if (typeof obj.clientSentAt !== "number") return null;

  switch (obj.type) {
    case "text": {
      if (typeof obj.text !== "string") return null;
      const replyTo = typeof obj.replyTo === "string" ? obj.replyTo : undefined;
      return {
        v: 1,
        id: obj.id,
        type: "text",
        clientSentAt: obj.clientSentAt,
        text: obj.text,
        ...(replyTo !== undefined ? { replyTo } : {}),
      };
    }
    case "edit": {
      if (typeof obj.targetId !== "string" || typeof obj.text !== "string") return null;
      return {
        v: 1,
        id: obj.id,
        type: "edit",
        clientSentAt: obj.clientSentAt,
        targetId: obj.targetId,
        text: obj.text,
      };
    }
    case "delete": {
      if (typeof obj.targetId !== "string") return null;
      return {
        v: 1,
        id: obj.id,
        type: "delete",
        clientSentAt: obj.clientSentAt,
        targetId: obj.targetId,
      };
    }
    case "read": {
      if (typeof obj.upToId !== "string") return null;
      return {
        v: 1,
        id: obj.id,
        type: "read",
        clientSentAt: obj.clientSentAt,
        upToId: obj.upToId,
      };
    }
    case "received": {
      if (!Array.isArray(obj.ids) || !obj.ids.every((x) => typeof x === "string")) return null;
      return {
        v: 1,
        id: obj.id,
        type: "received",
        clientSentAt: obj.clientSentAt,
        ids: obj.ids as string[],
      };
    }
    case "typing": {
      if (obj.state !== "started" && obj.state !== "stopped") return null;
      return {
        v: 1,
        id: obj.id,
        type: "typing",
        clientSentAt: obj.clientSentAt,
        state: obj.state,
      };
    }
    case "selfEcho": {
      if (typeof obj.originalPeer !== "string" || !obj.originalPeer) return null;
      if (typeof obj.original !== "object" || obj.original === null) return null;
      const inner = decodeEvent(JSON.stringify(obj.original));
      if (inner === null) return null;
      if (inner.type !== "text" && inner.type !== "edit" &&
          inner.type !== "delete" && inner.type !== "read") {
        return null;
      }
      return {
        v: 1,
        id: obj.id,
        type: "selfEcho",
        clientSentAt: obj.clientSentAt,
        originalPeer: obj.originalPeer,
        original: inner,
      };
    }
    default:
      return null;
  }
}

/** Convenience: marshal to bytes for the encrypt boundary. */
export function encodeEventBytes(event: ContentEvent): Uint8Array {
  return enc.encode(encodeEvent(event));
}

export function decodeEventBytes(bytes: Uint8Array): ContentEvent | null {
  return decodeEvent(dec.decode(bytes));
}

// ── factory helpers (for the SDK send paths) ────────────────────────────────

function newId(): string {
  // Use the SDK's UUID helper so we get the same defensive fallback path
  // (raw getRandomValues → manual v4 layout) when running on engines that
  // don't yet ship crypto.randomUUID natively.
  return generateUUID();
}

export function newText(text: string, replyTo?: string): TextEvent {
  return {
    v: 1,
    id: newId(),
    type: "text",
    clientSentAt: Date.now(),
    text,
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

export function newEdit(targetId: string, text: string): EditEvent {
  return { v: 1, id: newId(), type: "edit", clientSentAt: Date.now(), targetId, text };
}

export function newDelete(targetId: string): DeleteEvent {
  return { v: 1, id: newId(), type: "delete", clientSentAt: Date.now(), targetId };
}

export function newRead(upToId: string): ReadEvent {
  return { v: 1, id: newId(), type: "read", clientSentAt: Date.now(), upToId };
}

export function newReceived(ids: string[]): ReceivedEvent {
  return { v: 1, id: newId(), type: "received", clientSentAt: Date.now(), ids };
}

export function newTyping(state: "started" | "stopped"): TypingEvent {
  return { v: 1, id: newId(), type: "typing", clientSentAt: Date.now(), state };
}

export function newSelfEcho(originalPeer: string, original: SelfEchoableEvent): SelfEchoEvent {
  return {
    v: 1,
    id: newId(),
    type: "selfEcho",
    clientSentAt: Date.now(),
    originalPeer,
    original,
  };
}

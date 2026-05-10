// Wire-contract types. Single source of truth for everything the SDK sends or
// receives over /api/chat/* (HTTP) and /chat/ws (WebSocket). Shapes mirror
// chat-wire-contract.md exactly — keep in sync.

// ── chat token ───────────────────────────────────────────────────────────────

export interface ChatTokenClaims {
  typ: "chat";
  iss: string; // base58 tenant pubkey
  sub: string; // tenant-local user id
  did: string; // device id (UUID)
  iat: number;
  exp: number;
  chatWebhookUrl: string;
  chatSend: boolean;
  chatReceive: boolean;
}

// ── HTTP (POST /api/chat/token response) ────────────────────────────────────

export interface MintTokenResponse {
  chatToken: string;
  expiresAt: number;
  /**
   * Closest dtelecom node WebSocket URL for this client's IP, computed
   * server-side via the existing @dtelecom/server-sdk-js node discovery
   * (Solana registry → /relevants ranking). The SDK uses this for /chat/ws.
   */
  chatNodeWsUrl: string;
}

// ── HTTP (key bundles) ───────────────────────────────────────────────────────

export interface OneTimeKey {
  id: string;
  public: string; // base64
}

export interface KeyBundleUploadRequest {
  deviceId: string;
  identityKeyCurve: string; // base64 32B
  identityKeyEd: string; // base64 32B
  signedPrekey: string; // base64 32B
  signedPrekeySig: string; // base64 64B
  fallbackPrekey: string; // base64 32B
  fallbackPrekeySig: string; // base64 64B
  fingerprint: string;
  oneTimeKeys?: OneTimeKey[];
}

export interface OtkTopupRequest {
  deviceId: string;
  oneTimeKeys: OneTimeKey[];
}

export interface OtkCountResponse {
  count: number;
}

export interface ClaimAllRequest {
  peerUserId: string;
}

export interface ClaimedDevice {
  deviceId: string;
  identityKeyCurve: string;
  identityKeyEd: string;
  signedPrekey: string;
  signedPrekeySig: string;
  oneTimeKey: OneTimeKey | null; // null when pool empty → use fallbackPrekey
  fallbackPrekey: string;
  fallbackPrekeySig: string;
  fingerprint: string;
  lastActiveAt: number;
}

export interface ClaimAllResponse {
  devices: ClaimedDevice[]; // empty array also means "peer blocked us" (silent)
}

export interface ListDevicesResponse {
  devices: Array<{
    deviceId: string;
    fingerprint: string;
    lastActiveAt: number;
  }>;
}

// ── HTTP (envelopes) ─────────────────────────────────────────────────────────

export interface PendingEnvelope {
  envelopeUuid: string;
  senderUserId: string;
  senderDeviceId: string;
  ciphertext: string; // base64
  msgType: "prekey" | "normal";
  receivedAt: number;
}

export interface PendingResponse {
  envelopes: PendingEnvelope[];
}

export interface AckRequest {
  deviceId: string;
  envelopeUuids: string[];
}

// ── HTTP (blocks) ────────────────────────────────────────────────────────────

export interface BlocksListResponse {
  blocked: string[];
}

// ── WebSocket frames (chat-wire-contract.md §3) ─────────────────────────────

export type FrameKind =
  | "chatSend"
  | "chatPing"
  | "chatEnvelope"
  | "chatSendResult"
  | "chatPong";

export interface ChatSendTarget {
  deviceId: string;
  ciphertext: string; // base64
  envelopeUuid: string;
}

export interface ChatSendFrame {
  kind: "chatSend";
  toUserId: string;
  ephemeral?: boolean;
  msgType?: "prekey" | "normal";
  targets: ChatSendTarget[];
}

export interface ChatPingFrame {
  kind: "chatPing";
}

export interface ChatEnvelopeFrame {
  kind: "chatEnvelope";
  envelopeUuid: string;
  senderUserId: string;
  senderDeviceId: string;
  ciphertext: string;
  msgType: "prekey" | "normal";
}

export interface ChatSendResult {
  envelopeUuid: string;
  status: "live" | "stored" | "dropped" | "error";
  error?: string;
}

export interface ChatSendResultFrame {
  kind: "chatSendResult";
  results: ChatSendResult[];
}

export interface ChatPongFrame {
  kind: "chatPong";
}

export type OutboundFrame = ChatSendFrame | ChatPingFrame;
export type InboundFrame = ChatEnvelopeFrame | ChatSendResultFrame | ChatPongFrame;

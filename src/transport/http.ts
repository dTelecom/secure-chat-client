// Typed HTTP client wrapping all /api/chat/* endpoints. Owns no auth state —
// the caller passes a chat token (or a callback that fetches one). Mirrors
// chat-wire-contract.md §2 exactly.

import type {
  AckRequest,
  BlocksListResponse,
  ClaimAllResponse,
  KeyBundleUploadRequest,
  ListDevicesResponse,
  MintTokenResponse,
  OneTimeKey,
  OtkCountResponse,
  OtkTopupRequest,
  PendingResponse,
} from "../types.js";

/**
 * Consumer-supplied callback that mints a chat token via the tenant backend.
 * Must return the full `POST /api/chat/token` response so the SDK can use the
 * server-discovered node URL (chatNodeWsUrl) — no Solana code on the client.
 */
export type FetchChatToken = (deviceId: string) => Promise<MintTokenResponse>;

export interface HttpClientOptions {
  /** Base URL of the dmeet-backend (or mock). e.g. "http://localhost:8787" */
  apiBaseURL: string;
  /** Function returning a valid chat token JWT. Called when the SDK needs auth. */
  fetchChatToken: FetchChatToken;
  /** Optional fetch implementation (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class HttpClient {
  private readonly apiBase: string;
  private readonly fetchToken: FetchChatToken;
  private readonly fetchImpl: typeof fetch;

  // Cached MintTokenResponse, keyed by device id. Refreshed when expired.
  private cached: MintTokenResponse | null = null;
  private cachedDeviceId: string | null = null;

  constructor(opts: HttpClientOptions) {
    this.apiBase = opts.apiBaseURL.replace(/\/$/, "");
    this.fetchToken = opts.fetchChatToken;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // ── token + node-url lifecycle ─────────────────────────────────────────────

  /**
   * Returns the full mint response (token + chatNodeWsUrl + expiry),
   * fetching afresh if no cached value exists or it expires within 60 seconds.
   * Also re-fetches when the device id changes.
   */
  async getMint(deviceId: string): Promise<MintTokenResponse> {
    const now = Math.floor(Date.now() / 1000);
    if (
      this.cached &&
      this.cachedDeviceId === deviceId &&
      this.cached.expiresAt - now > 60
    ) {
      return this.cached;
    }
    const mint = await this.fetchToken(deviceId);
    if (!mint.chatToken || typeof mint.expiresAt !== "number" || !mint.chatNodeWsUrl) {
      throw new Error("fetchChatToken must return { chatToken, expiresAt, chatNodeWsUrl }");
    }
    this.cached = mint;
    this.cachedDeviceId = deviceId;
    return mint;
  }

  /** Convenience: just the JWT. Backed by getMint(). */
  async getToken(deviceId: string): Promise<string> {
    return (await this.getMint(deviceId)).chatToken;
  }

  /** Convenience: just the discovered node WS URL. Backed by getMint(). */
  async getNodeWsUrl(deviceId: string): Promise<string> {
    return (await this.getMint(deviceId)).chatNodeWsUrl;
  }

  // ── authed JSON helpers ────────────────────────────────────────────────────

  private async authedJson<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    deviceId: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getToken(deviceId);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    let bodyText: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      bodyText = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers,
      body: bodyText,
    });
    if (!res.ok) {
      let code = "http_error";
      let msg = `${res.status} ${res.statusText}`;
      try {
        const errJson = (await res.json()) as { error?: string; message?: string };
        if (errJson.error) code = errJson.error;
        if (errJson.message) msg = errJson.message;
      } catch {
        // body wasn't JSON
      }
      throw new HttpError(res.status, code, msg);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ── /api/chat/keys ─────────────────────────────────────────────────────────

  uploadKeyBundle(deviceId: string, body: KeyBundleUploadRequest): Promise<{ ok: true }> {
    return this.authedJson("POST", "/api/chat/keys/upload", deviceId, body);
  }

  topupOtks(deviceId: string, keys: OneTimeKey[]): Promise<{ ok: true; currentCount: number }> {
    const body: OtkTopupRequest = { deviceId: deviceId, oneTimeKeys: keys };
    return this.authedJson("POST", "/api/chat/keys/topup", deviceId, body);
  }

  otkCount(deviceId: string): Promise<OtkCountResponse> {
    return this.authedJson(
      "GET",
      `/api/chat/keys/count?deviceId=${encodeURIComponent(deviceId)}`,
      deviceId,
    );
  }

  claimAll(deviceId: string, peerUserId: string): Promise<ClaimAllResponse> {
    return this.authedJson("POST", "/api/chat/keys/claim_all", deviceId, {
      peerUserId: peerUserId,
    });
  }

  listDevices(deviceId: string, peerUserId: string): Promise<ListDevicesResponse> {
    return this.authedJson(
      "GET",
      `/api/chat/keys/list_devices?peerUserId=${encodeURIComponent(peerUserId)}`,
      deviceId,
    );
  }

  // ── /api/chat/envelopes ────────────────────────────────────────────────────

  pending(deviceId: string, limit = 100): Promise<PendingResponse> {
    return this.authedJson(
      "GET",
      `/api/chat/envelopes/pending?deviceId=${encodeURIComponent(deviceId)}&limit=${limit}`,
      deviceId,
    );
  }

  ack(deviceId: string, envelopeUuids: string[]): Promise<{ ok: true; deletedCount: number }> {
    const body: AckRequest = { deviceId: deviceId, envelopeUuids: envelopeUuids };
    return this.authedJson("POST", "/api/chat/envelopes/ack", deviceId, body);
  }

  // ── /api/chat/blocks ───────────────────────────────────────────────────────

  blockUser(deviceId: string, peerUserId: string): Promise<{ ok: true }> {
    return this.authedJson("POST", "/api/chat/blocks", deviceId, { peerUserId: peerUserId });
  }

  unblockUser(deviceId: string, peerUserId: string): Promise<{ ok: true }> {
    return this.authedJson(
      "DELETE",
      `/api/chat/blocks/${encodeURIComponent(peerUserId)}`,
      deviceId,
    );
  }

  listBlocked(deviceId: string): Promise<BlocksListResponse> {
    return this.authedJson("GET", "/api/chat/blocks", deviceId);
  }
}

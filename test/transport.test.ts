// Unit tests for the transport layer using mocked fetch + a tiny FakeWebSocket.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../src/transport/http.js";
import { WsClient } from "../src/transport/ws.js";
import type { ChatEnvelopeFrame, InboundFrame, MintTokenResponse } from "../src/types.js";

// ── HTTP tests ───────────────────────────────────────────────────────────────

function makeFetch(routes: Record<string, (req: Request) => Response | Promise<Response>>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ error: "not_implemented", key }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }
    return handler(req);
  };
}

const FAKE_JWT = "header.body.sig";
function fakeMint(): MintTokenResponse {
  return {
    chatToken: FAKE_JWT,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    chatNodeWsUrl: "wss://node.test/chat/ws",
  };
}

describe("HttpClient", () => {
  it("caches mint until close to expiry", async () => {
    const fetchToken = vi.fn(async () => fakeMint());
    const client = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: fetchToken,
      fetchImpl: makeFetch({}),
    });
    await client.getToken("dev1");
    await client.getNodeWsUrl("dev1");
    await client.getToken("dev1");
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when device id changes", async () => {
    const fetchToken = vi.fn(async () => fakeMint());
    const client = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: fetchToken,
      fetchImpl: makeFetch({}),
    });
    await client.getToken("dev1");
    await client.getToken("dev2");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("getNodeWsUrl returns the server-discovered URL", async () => {
    const client = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchImpl: makeFetch({}),
    });
    expect(await client.getNodeWsUrl("dev1")).toBe("wss://node.test/chat/ws");
  });

  it("rejects malformed mint response", async () => {
    const client = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => ({ chatToken: "x", expiresAt: 0 } as MintTokenResponse),
      fetchImpl: makeFetch({}),
    });
    await expect(client.getToken("d")).rejects.toThrow(/chatNodeWsUrl/);
  });

  it("attaches Bearer to authed requests", async () => {
    const fetchToken = vi.fn(async () => fakeMint());
    const seen: string[] = [];
    const client = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: fetchToken,
      fetchImpl: makeFetch({
        "GET /api/chat/blocks": (req) => {
          seen.push(req.headers.get("authorization") ?? "");
          return new Response(JSON.stringify({ blocked: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    });
    await client.listBlocked("dev1");
    expect(seen[0]).toBe(`Bearer ${FAKE_JWT}`);
  });

  it("throws HttpError with code+message on backend error", async () => {
    const client = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchImpl: makeFetch({
        "POST /api/chat/blocks": () =>
          new Response(JSON.stringify({ error: "self_block", message: "cannot block self" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      }),
    });
    await expect(client.blockUser("dev1", "alice")).rejects.toMatchObject({
      name: "HttpError",
      status: 400,
      code: "self_block",
    });
  });

  it("calls each /api/chat/* path with the right method + body shape", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const recordHandler = (status = 200, resp: unknown = { ok: true }) =>
      async (req: Request) => {
        calls.push({
          method: req.method,
          path: new URL(req.url).pathname,
          body: req.body ? await req.json() : undefined,
        });
        return new Response(JSON.stringify(resp), {
          status,
          headers: { "content-type": "application/json" },
        });
      };

    const client = new HttpClient({
      apiBaseURL: "http://test",
      fetchChatToken: async () => fakeMint(),
      fetchImpl: makeFetch({
        "POST /api/chat/keys/upload": recordHandler(),
        "POST /api/chat/keys/topup": recordHandler(200, { ok: true, currentCount: 5 }),
        "GET /api/chat/keys/count": recordHandler(200, { count: 3 }),
        "POST /api/chat/keys/claim_all": recordHandler(200, { devices: [] }),
        "GET /api/chat/keys/list_devices": recordHandler(200, { devices: [] }),
        "GET /api/chat/envelopes/pending": recordHandler(200, { envelopes: [] }),
        "POST /api/chat/envelopes/ack": recordHandler(200, { ok: true, deletedCount: 0 }),
        "POST /api/chat/blocks": recordHandler(),
        "DELETE /api/chat/blocks/bob": recordHandler(),
        "GET /api/chat/blocks": recordHandler(200, { blocked: [] }),
      }),
    });

    await client.uploadKeyBundle("dev1", {
      deviceId: "dev1",
      identityKeyCurve: "K1",
      identityKeyEd: "K2",
      signedPrekey: "K3",
      signedPrekeySig: "K4",
      fallbackPrekey: "K5",
      fallbackPrekeySig: "K6",
      fingerprint: "FP",
    });
    await client.topupOtks("dev1", [{ id: "o1", public: "p1" }]);
    await client.otkCount("dev1");
    await client.claimAll("dev1", "alice");
    await client.listDevices("dev1", "alice");
    await client.pending("dev1", 50);
    await client.ack("dev1", ["env1"]);
    await client.blockUser("dev1", "bob");
    await client.unblockUser("dev1", "bob");
    await client.listBlocked("dev1");

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/chat/keys/upload",
      "POST /api/chat/keys/topup",
      "GET /api/chat/keys/count",
      "POST /api/chat/keys/claim_all",
      "GET /api/chat/keys/list_devices",
      "GET /api/chat/envelopes/pending",
      "POST /api/chat/envelopes/ack",
      "POST /api/chat/blocks",
      "DELETE /api/chat/blocks/bob",
      "GET /api/chat/blocks",
    ]);
    // ack carries deviceId + envelopeUuids
    expect(calls[6].body).toEqual({ deviceId: "dev1", envelopeUuids: ["env1"] });
  });
});

// ── WS tests ─────────────────────────────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = FakeWebSocket.CLOSED;
    void code;
    void reason;
    queueMicrotask(() => this.onclose?.(new Event("close") as CloseEvent));
  }
  // Test helpers
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  fireMessage(data: unknown) {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    this.onmessage?.({ data: text } as MessageEvent);
  }
  fireClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new Event("close") as CloseEvent);
  }
}

describe("WsClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function waitForInstance(): Promise<FakeWebSocket> {
    for (let i = 0; i < 100; i++) {
      if (FakeWebSocket.instances.length > 0) return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      await Promise.resolve();
    }
    throw new Error("FakeWebSocket never instantiated");
  }

  it("connects, calls onState, and forwards inbound frames", async () => {
    const states: string[] = [];
    const frames: InboundFrame[] = [];
    const client = new WsClient({
      nodeBaseURL: "wss://node.test",
      getToken: async () => "TOK",
      onFrame: (f) => frames.push(f),
      onState: (s) => states.push(s),
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnect: false,
      pingIntervalMs: 0,
    });
    const p = client.connect();
    const ws = await waitForInstance();
    expect(ws.url).toContain("/chat/ws?access_token=TOK");
    ws.fireOpen();
    await p;

    expect(states).toEqual(["connecting", "open"]);

    const env: ChatEnvelopeFrame = {
      kind: "chatEnvelope",
      envelopeUuid: "u1",
      senderUserId: "alice",
      senderDeviceId: "dev-a",
      ciphertext: "C",
      msgType: "normal",
    };
    ws.fireMessage(env);
    expect(frames).toEqual([env]);
  });

  it("throws on send when not open", () => {
    const client = new WsClient({
      nodeBaseURL: "wss://node.test",
      getToken: async () => "TOK",
      onFrame: () => {},
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnect: false,
      pingIntervalMs: 0,
    });
    expect(() => client.sendChat({ toUserId: "bob", targets: [] })).toThrow();
  });

  it("encodes chatSend frames as JSON over the WS", async () => {
    const client = new WsClient({
      nodeBaseURL: "wss://node.test",
      getToken: async () => "TOK",
      onFrame: () => {},
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnect: false,
      pingIntervalMs: 0,
    });
    const p = client.connect();
    const ws = await waitForInstance();
    ws.fireOpen();
    await p;

    client.sendChat({
      toUserId: "bob",
      targets: [{ deviceId: "bob-phone", ciphertext: "C", envelopeUuid: "u1" }],
    });
    expect(ws.sent).toHaveLength(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.kind).toBe("chatSend");
    expect(sent.toUserId).toBe("bob");
    expect(sent.targets[0].envelopeUuid).toBe("u1");
  });

  it("transitions to reconnecting on close when reconnect=true", async () => {
    const states: string[] = [];
    const client = new WsClient({
      nodeBaseURL: "wss://node.test",
      getToken: async () => "TOK",
      onFrame: () => {},
      onState: (s) => states.push(s),
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnect: true,
      pingIntervalMs: 0,
    });
    const p = client.connect();
    const ws = await waitForInstance();
    ws.fireOpen();
    await p;
    ws.fireClose();
    expect(states).toContain("reconnecting");
    // Stop the auto-reconnect from spawning more WS instances asynchronously.
    await client.close();
  });
});

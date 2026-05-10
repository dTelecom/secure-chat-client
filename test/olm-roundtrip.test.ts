// Real Olm WASM round-trip. Two OlmCryptoAdapter instances exchange a
// message end-to-end. Validates the WASM wrapper, not just the
// orchestration above it.

import { beforeAll, describe, expect, it } from "vitest";
import { OlmCryptoAdapter } from "../src/crypto/olm-adapter.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";

let aliceCrypto: OlmCryptoAdapter;
let bobCrypto: OlmCryptoAdapter;

beforeAll(async () => {
  aliceCrypto = new OlmCryptoAdapter({ store: new MemoryKVStore() });
  bobCrypto = new OlmCryptoAdapter({ store: new MemoryKVStore() });
  await aliceCrypto.init();
  await bobCrypto.init();
});

describe("OlmCryptoAdapter — real WASM round-trip", () => {
  it("alice → bob: prekey then normal", async () => {
    await aliceCrypto.generateAccount(10);
    const bobBundle = await bobCrypto.generateAccount(10);

    const peerForAlice = {
      deviceId: "bob-phone",
      identityKeyCurve: bobBundle.identityKeyCurve,
      identityKeyEd: bobBundle.identityKeyEd,
      signedPrekey: bobBundle.signedPrekey,
      signedPrekeySig: bobBundle.signedPrekeySig,
      oneTimeKey: bobBundle.oneTimeKeys[0] ?? null,
      fallbackPrekey: bobBundle.fallbackPrekey,
      fallbackPrekeySig: bobBundle.fallbackPrekeySig,
      fingerprint: bobBundle.fingerprint,
      lastActiveAt: 0,
    };

    // Alice → Bob: first message (prekey).
    const env1 = await aliceCrypto.encryptForPeer("bob", "bob-phone", peerForAlice, "hello bob");
    expect(env1.msgType).toBe("prekey");
    const recv1 = await bobCrypto.decryptFromPeer("alice", "alice-mac", env1.ciphertext, "prekey");
    expect(recv1).toBe("hello bob");

    // Alice → Bob: second message — Olm keeps emitting prekey-type until
    // alice's session receives a reply back from bob, so her first few
    // outbound messages are all type=0. Verify it round-trips correctly.
    const env2 = await aliceCrypto.encryptForPeer("bob", "bob-phone", peerForAlice, "second message");
    const recv2 = await bobCrypto.decryptFromPeer("alice", "alice-mac", env2.ciphertext, env2.msgType);
    expect(recv2).toBe("second message");

    // Bob → Alice: bob has a fully-established session (he received alice's
    // prekey, ran create_inbound, decrypted), so his outbound is "normal".
    const aliceBundle = await aliceCrypto.getCurrentBundle();
    const peerForBob = {
      deviceId: "alice-mac",
      identityKeyCurve: aliceBundle.identityKeyCurve,
      identityKeyEd: aliceBundle.identityKeyEd,
      signedPrekey: aliceBundle.signedPrekey,
      signedPrekeySig: aliceBundle.signedPrekeySig,
      oneTimeKey: null,
      fallbackPrekey: aliceBundle.fallbackPrekey,
      fallbackPrekeySig: aliceBundle.fallbackPrekeySig,
      fingerprint: aliceBundle.fingerprint,
      lastActiveAt: 0,
    };
    const env3 = await bobCrypto.encryptForPeer("alice", "alice-mac", peerForBob, "hi alice");
    expect(env3.msgType).toBe("normal");
    const recv3 = await aliceCrypto.decryptFromPeer("bob", "bob-phone", env3.ciphertext, "normal");
    expect(recv3).toBe("hi alice");

    // Alice → Bob: now alice's session has received bob's reply, so future
    // outbound messages flip to normal-type.
    const env4 = await aliceCrypto.encryptForPeer("bob", "bob-phone", peerForAlice, "third message");
    expect(env4.msgType).toBe("normal");
    const recv4 = await bobCrypto.decryptFromPeer("alice", "alice-mac", env4.ciphertext, "normal");
    expect(recv4).toBe("third message");
  });

  it("session persists across adapter restart (pickle/unpickle)", async () => {
    const store = new MemoryKVStore();
    const a1 = new OlmCryptoAdapter({ store });
    await a1.init();
    await a1.generateAccount(5);

    // simulate restart — new adapter instance, same store
    const a2 = new OlmCryptoAdapter({ store });
    await a2.init();
    expect(await a2.hasAccount()).toBe(true);
    const bundle = await a2.getCurrentBundle();
    expect(bundle.identityKeyCurve).toBeTruthy();
  });

  it("OTK count drops as keys are consumed (mark_keys_as_published)", async () => {
    const store = new MemoryKVStore();
    const a = new OlmCryptoAdapter({ store });
    await a.init();
    await a.generateAccount(5);
    // After generateAccount, mark_keys_as_published clears the unpublished list
    expect(await a.unusedOneTimeKeyCount()).toBe(0);
    // Top-up: generate more, read before publish
    const fresh = await a.generateOneTimeKeys(10);
    expect(fresh.length).toBe(10);
    // After generateOneTimeKeys, we mark_as_published internally — count is 0 again
    expect(await a.unusedOneTimeKeyCount()).toBe(0);
  });
});

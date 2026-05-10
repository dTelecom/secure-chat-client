// Browser-mode smoke: two OlmCryptoAdapter instances run inside a
// real Chromium, exchange Olm messages over an in-process channel,
// and round-trip every content event type the SDK persists in
// history (text / edit / delete / read).
//
// This is the only test that proves @dtelecom/vodozemac-wasm's
// pkg-web bundle parses + executes in a browser environment. The
// network-side smokes run against Node + tsx; if the WASM glue or
// the wasm-bindgen `--target web` output had a runtime issue we
// would only catch it once an actual app loaded the SDK.

import { describe, expect, it } from "vitest";
import { OlmCryptoAdapter } from "../../src/crypto/olm-adapter.js";
import { MemoryKVStore } from "../../src/store/memory-adapter.js";
import {
  encodeEvent,
  decodeEvent,
  newDelete,
  newEdit,
  newRead,
  newSelfEcho,
  newText,
} from "../../src/content/protocol.js";

async function makeAdapter(): Promise<{
  adapter: OlmCryptoAdapter;
  bundle: Awaited<ReturnType<OlmCryptoAdapter["generateAccount"]>>;
}> {
  const adapter = new OlmCryptoAdapter({ store: new MemoryKVStore() });
  await adapter.init();
  // generateAccount snapshots OTKs BEFORE markKeysAsPublished — the
  // returned bundle is the only place to find the unpublished public
  // OTKs we then upload to peers. getCurrentBundle() runs post-publish
  // and returns oneTimeKeys: [].
  const bundle = await adapter.generateAccount(5);
  return { adapter, bundle };
}

describe("vodozemac-wasm in a real browser", () => {
  it("alice ↔ bob round-trip text/edit/delete/read via Olm sessions", async () => {
    const { adapter: alice, bundle: aliceBundle } = await makeAdapter();
    const { adapter: bob, bundle: bobBundle } = await makeAdapter();

    const peerForAlice = {
      deviceId: "bob-phone",
      identityKeyCurve: bobBundle.identityKeyCurve,
      identityKeyEd: bobBundle.identityKeyEd,
      signedPrekey: bobBundle.signedPrekey,
      signedPrekeySig: bobBundle.signedPrekeySig,
      oneTimeKey: bobBundle.oneTimeKeys[0],
      fallbackPrekey: bobBundle.fallbackPrekey,
      fallbackPrekeySig: bobBundle.fallbackPrekeySig,
      fingerprint: bobBundle.fingerprint,
      lastActiveAt: 0,
    };

    // ── alice → bob: text (prekey establishes the session)
    const text = newText("hello-from-browser");
    const env1 = await alice.encryptForPeer("bob", "bob-phone", peerForAlice, encodeEvent(text));
    const recv1 = await bob.decryptFromPeer("alice", "alice-mac", env1.ciphertext, env1.msgType);
    const decoded1 = decodeEvent(recv1);
    expect(decoded1).toEqual(text);

    // ── alice → bob: edit (still prekey-type until bob replies)
    const editEv = newEdit(text.id, "edited-in-browser");
    const env2 = await alice.encryptForPeer("bob", "bob-phone", peerForAlice, encodeEvent(editEv));
    const recv2 = await bob.decryptFromPeer("alice", "alice-mac", env2.ciphertext, env2.msgType);
    expect(decodeEvent(recv2)).toEqual(editEv);

    // ── bob → alice: delete (bob's session is fully bootstrapped — normal)
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
    const delEv = newDelete(text.id);
    const env3 = await bob.encryptForPeer("alice", "alice-mac", peerForBob, encodeEvent(delEv));
    expect(env3.msgType).toBe("normal");
    const recv3 = await alice.decryptFromPeer("bob", "bob-phone", env3.ciphertext, "normal");
    expect(decodeEvent(recv3)).toEqual(delEv);

    // ── alice → bob: read (now alice's session is fully bootstrapped — normal)
    const readEv = newRead(text.id);
    const env4 = await alice.encryptForPeer("bob", "bob-phone", peerForAlice, encodeEvent(readEv));
    expect(env4.msgType).toBe("normal");
    const recv4 = await bob.decryptFromPeer("alice", "alice-mac", env4.ciphertext, "normal");
    expect(decodeEvent(recv4)).toEqual(readEv);
  });

  it("selfEcho codec roundtrips wrapped text in a real browser", () => {
    // Pure-codec test (no WASM required) — included here so we have
    // browser coverage of the content-protocol path the SDK relies on
    // for multi-device sync.
    const inner = newText("inner");
    const echo = newSelfEcho("bob", inner);
    const decoded = decodeEvent(encodeEvent(echo));
    expect(decoded).toEqual(echo);
  });
});

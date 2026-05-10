import { Account, Session } from "@dtelecom/vodozemac-wasm";

const alice = new Account();
const bob = new Account();
bob.generateOneTimeKeys(2);
const bobIdent = JSON.parse(bob.identityKeys());
const otks = JSON.parse(bob.oneTimeKeys()).curve25519;
const [bobOtkId, bobOtkPub] = Object.entries(otks)[0];
console.log("bob identity curve:", bobIdent.curve25519);
console.log("bob OTK:", bobOtkId, "→", bobOtkPub);
bob.markKeysAsPublished();

const aliceSess = alice.createOutboundSession(bobIdent.curve25519, bobOtkPub);
const enc = JSON.parse(aliceSess.encrypt("hello via vodozemac"));
console.log("alice sent:", enc);

const aliceIdent = JSON.parse(alice.identityKeys());
const inbound = bob.createInboundSession(aliceIdent.curve25519, enc.body);
const bobSess = inbound.takeSession();
console.log("bob decrypted:", inbound.plaintext);

const enc2 = JSON.parse(bobSess.encrypt("hi back"));
console.log("bob sent:", enc2);
const plain2 = aliceSess.decrypt(enc2.type, enc2.body);
console.log("alice decrypted:", plain2);

const p = bobSess.pickle();
const restored = Session.fromPickle(p);
console.log("pickle/unpickle OK; sessionId =", restored.sessionId());

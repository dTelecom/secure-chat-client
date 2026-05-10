// smoke:idle — N (default 50) WS connections sit idle for 30 seconds. We
// observe the mock backend's HTTP request count and require it does not
// grow over the window — proving the dtelecom node's presence layer
// does NOT chat with the backend on idle traffic. Ten thousand devices
// in production must produce zero presence chatter.
//
// We can't directly count HTTP requests on the mock without wiring a
// counter; instead we use mock state's `envelopes_by_recipient` and
// `pushes_fired` as proxy — neither should grow during idle.
//
// Smaller N for local-dev-friendliness; raise via env IDLE_N=1000.

import { runSmoke, check, rawConnect, getMockState, resetMock, delay, env } from "./_smoke-helpers.js";

const N = Number(env.IDLE_N ?? 50);
const WINDOW_MS = Number(env.IDLE_WINDOW_MS ?? 30_000);

await runSmoke(`smoke:idle (N=${N}, window=${WINDOW_MS}ms)`, async () => {
  await resetMock();

  const sides = [];
  for (let i = 0; i < N; i++) {
    sides.push(await rawConnect(`idle-user-${i}`, `idle-dev-${i}`));
  }
  console.log(`  ${N} WS connections established; idling for ${WINDOW_MS}ms`);

  const before = await getMockState();
  await delay(WINDOW_MS);
  const after = await getMockState();

  const newEnvelopes =
    after.envelopes_by_recipient.reduce((s, e) => s + e.count, 0) -
    before.envelopes_by_recipient.reduce((s, e) => s + e.count, 0);
  const newPushes = after.pushes_fired - before.pushes_fired;

  check(`zero offline-fallback envelopes during idle (got ${newEnvelopes})`, newEnvelopes === 0);
  check(`zero pushes fired during idle (got ${newPushes})`, newPushes === 0);

  await Promise.all(sides.map((s) => s.ws.close()));
});

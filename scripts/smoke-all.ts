// smoke:all — runs every Stage D scenario in sequence with a clear
// PASS/FAIL summary. Each smoke is an independent script; this file
// just shells out via tsx so each runs in its own process (clean
// state, no cross-contamination).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPTS = [
  "smoke-auth.ts",
  "smoke-fanout.ts",
  "smoke-ephemeral.ts",
  "smoke-offline-fallback.ts",
  "smoke-push-gating.ts",
  "smoke-edit-delete-authz.ts",
  "smoke-read-typing.ts",
  "smoke-fwd-compat.ts",
  "smoke-crash-recovery.ts",
  "smoke-node-failure.ts",
  "smoke-history-reload.ts",
  "smoke-multi-device-sender.ts",
  "smoke-self-echo.ts",
  "smoke-peer-new-device.ts",
  "smoke-otk-exhaustion.ts",
  "smoke-read-receipts-gating.ts",
  "smoke-conversations.ts",
  "smoke-idle.ts",
];

const here = dirname(fileURLToPath(import.meta.url));

function runOne(name: string): Promise<{ name: string; code: number; ms: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn("npx", ["tsx", join(here, name)], { stdio: "inherit" });
    proc.on("exit", (code) => {
      resolve({ name, code: code ?? 1, ms: Date.now() - start });
    });
  });
}

const results: Array<{ name: string; code: number; ms: number }> = [];
for (const s of SCRIPTS) {
  console.log(`\n████ ${s} ████`);
  const r = await runOne(s);
  results.push(r);
}

console.log("\n████ smoke:all summary ████");
let passed = 0;
let failed = 0;
for (const r of results) {
  const tag = r.code === 0 ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${r.name.padEnd(30)} ${r.ms}ms`);
  if (r.code === 0) passed++;
  else failed++;
}
console.log(`\n${passed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);

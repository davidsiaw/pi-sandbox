/**
 * selftest.mjs — session-replacement guard for pa-anthropic-oauth.
 *
 * WHY THIS EXISTS
 *   `/resume` could kill pi outright:
 *
 *     Error: This extension ctx is stale after session replacement or reload.
 *       at get ui (.../extensions/runner.js:465:24)
 *       at updateUsageStatus (pa-anthropic-oauth/index.ts:478:62)
 *       at Timeout.poll [as _onTimeout]
 *
 *   The usage poller started a 60s setInterval from `session_start` and closed
 *   over that session's ctx. pi's docs are explicit that anything started in
 *   session_start needs "an idempotent session_shutdown handler", and there was
 *   none — so the interval outlived its session, and on the next tick the
 *   `ctx.ui` GETTER threw. From a timer callback nothing catches that, so it
 *   reached the process as an uncaughtException. Worse, every /resume added
 *   another interval and another stdout "resize" listener.
 *
 * WHAT IT ASSERTS, by driving three sessions through the real module:
 *   (1) no uncaughtException/unhandledRejection when a poll fires while stale
 *       ctxs from previous sessions still exist;
 *   (2) exactly ONE live interval remains after 3 sessions (no timer pile-up);
 *   (3) exactly ONE stdout "resize" listener remains (no listener pile-up).
 *
 *   It models pi's real ordering, per docs/extensions.md: session_shutdown goes
 *   to the OLD extension instance, then extensions are reloaded and rebound,
 *   then the new instance gets session_start. So each session here gets a fresh
 *   module instance and the old instance is the one torn down.
 *
 * Auth-free: no token, no network, no model. The provider registration and the
 * usage fetch are inert because the fake ctx never supplies credentials.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_MODULES = `${PI_ROOT}/node_modules`;

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

const { createJiti } = await import(`${PI_MODULES}/jiti/lib/jiti.mjs`);
const alias = {
  "@earendil-works/pi-tui": `${PI_MODULES}/@earendil-works/pi-tui`,
  "@earendil-works/pi-coding-agent": PI_ROOT,
};

// Count only intervals this extension creates.
let liveIntervals = 0;
const owned = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const t = realSetInterval(fn, ms, ...rest);
  owned.add(t);
  liveIntervals++;
  return t;
};
globalThis.clearInterval = (t) => {
  if (owned.has(t)) {
    owned.delete(t);
    liveIntervals--;
  }
  return realClearInterval(t);
};

function makeCtx() {
  let stale = false;
  const ui = { theme: { fg: (_k, s) => s }, setStatus: () => {} };
  return {
    kill: () => { stale = true; },
    model: { provider: "anthropic-oauth" },
    get ui() {
      // Mirrors ExtensionRunner.assertActive(): the GETTER throws, so any
      // `ctx.ui.<anything>` on a replaced session blows up, not just setStatus.
      if (stale) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload."
        );
      }
      return ui;
    },
  };
}

function fakePi() {
  const handlers = new Map();
  const pi = {
    registerProvider() {},
    registerCommand() {},
    registerTool() {},
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, []);
      handlers.get(evt).push(fn);
    },
  };
  const emit = async (evt, event, ctx) => {
    for (const fn of handlers.get(evt) ?? []) await fn(event, ctx);
  };
  return { pi, emit };
}

let uncaught = null;
process.on("uncaughtException", (e) => { uncaught = e; });
process.on("unhandledRejection", (e) => { uncaught = e; });

const baselineResize = process.stdout.listenerCount("resize");
let prev = null;

for (let i = 0; i < 3; i++) {
  if (prev) {
    await prev.emit("session_shutdown", { reason: "resume" }, prev.ctx);
    prev.ctx.kill(); // ctx goes stale only AFTER the old instance tore down
  }
  const jiti = createJiti(`file://${HERE}/`, {
    interopDefault: true,
    alias,
    fsCache: false,
    moduleCache: false,
  });
  const mod = await jiti.import(`${HERE}/index.ts`);
  const inst = fakePi();
  (mod.default ?? mod)(inst.pi);
  const ctx = makeCtx();
  await inst.emit("session_start", { reason: i === 0 ? "new" : "resume" }, ctx);
  prev = { ...inst, ctx };
}

// Fire the poll callback the way the 60s interval would, with two stale ctxs
// from previous sessions still reachable from any leaked closure.
for (const t of owned) {
  try {
    t._onTimeout?.();
  } catch (e) {
    uncaught = e;
  }
}
await new Promise((r) => setTimeout(r, 400));

const resizeLeak = process.stdout.listenerCount("resize") - baselineResize;

check(
  "no uncaughtException when a poll fires after session replacement",
  uncaught === null,
  uncaught ? String(uncaught.message).slice(0, 90) : ""
);
check(
  "exactly one live poll interval after 3 sessions (no timer pile-up)",
  liveIntervals === 1,
  `got ${liveIntervals}`
);
check(
  "exactly one stdout resize listener after 3 sessions (no listener pile-up)",
  resizeLeak === 1,
  `got ${resizeLeak}`
);

console.log(
  failed === 0 ? "\nselftest: all checks passed" : `\nselftest: ${failed} check(s) FAILED`
);
process.exit(failed === 0 ? 0 : 1);

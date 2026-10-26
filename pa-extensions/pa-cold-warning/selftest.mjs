/**
 * selftest.mjs — auth-free guard for pa-cold-warning.
 *
 * Loads index.ts through pi's jiti, drives it with a fake pi + ctx, and asserts:
 *   (1) a prompt inside the TTL passes straight through, no dialog;
 *   (2) a cold prompt shows a dialog with the restore cost, and Restore lets
 *       the prompt through;
 *   (3) Cancel puts the text back in the editor;
 *   (4) small contexts and non-Claude models are ignored;
 *   (5) no model request is ever made (no automatic summary).
 *
 * Usage: node selftest.mjs   (exit 0 = pass)
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
const jiti = createJiti(`file://${HERE}/`, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": PI_ROOT },
  fsCache: false,
  moduleCache: false,
});
const mod = await jiti.import(`${HERE}/index.ts`);
const factory = mod.default ?? mod;

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const CLAUDE = { provider: "anthropic", id: "claude-opus-5", promptCache: { short: 2 }, cost: { input: 5, cacheWrite: 6.25 } };
const USAGE = { input: 2, output: 500, cacheRead: 100_000, cacheWrite: 1_000 };

function setup({ model = CLAUDE, choose, replyAgoMs = 500, usage = USAGE } = {}) {
  const handlers = new Map();
  const state = { calls: 0, selects: [], editor: undefined };
  const branch = [
    { type: "message", timestamp: iso(replyAgoMs + 500), message: { role: "user", content: "do the thing" } },
    { type: "message", timestamp: iso(replyAgoMs), message: { role: "assistant", stopReason: "stop", usage, content: [] } },
  ];
  factory({ on: (e, f) => handlers.set(e, f) });
  const ctx = {
    model,
    hasUI: true,
    ui: {
      notify: () => {},
      select: async (title, opts) => (state.selects.push([title, opts]), choose ? opts.find(choose) : undefined),
      setEditorText: (t) => (state.editor = t),
    },
    sessionManager: { getBranch: () => branch },
    modelRegistry: { streamSimple: () => (state.calls++, { result: async () => ({}) }) },
  };
  const emit = (e, ev) => handlers.get(e)?.({ type: e, ...ev }, ctx);
  return { emit, state, handlers };
}

// (1) warm prompt passes through
{
  const t = setup();
  const r = await t.emit("input", { text: "next", source: "interactive" });
  check("warm prompt: no dialog, not handled", t.state.selects.length === 0 && r === undefined);
}

// (2) cold prompt -> restore
{
  const t = setup({ replyAgoMs: 6000, choose: (o) => o.startsWith("Restore") });
  const r = await t.emit("input", { text: "continue please", source: "interactive" });
  check("cold prompt shows dialog", t.state.selects.length === 1);
  check("dialog shows restore cost", /\$0\.6\d/.test(t.state.selects[0]?.[1].join("|")), t.state.selects[0]?.[1].join("|"));
  check("no compact option offered", !t.state.selects[0]?.[1].some((o) => /compact/i.test(o)));
  check("restore -> prompt passes through", r === undefined);
}

// (3) cancel keeps text
{
  const t = setup({ replyAgoMs: 6000, choose: (o) => o.startsWith("Cancel") });
  const r = await t.emit("input", { text: "hello again", source: "interactive" });
  check("cancel -> handled, text back in editor", r?.action === "handled" && t.state.editor === "hello again");
}

// (4) small context / non-Claude ignored
{
  const t = setup({ replyAgoMs: 6000, usage: { input: 10, output: 10, cacheRead: 1000, cacheWrite: 0 } });
  await t.emit("input", { text: "x", source: "interactive" });
  check("small context: no dialog", t.state.selects.length === 0);
}
{
  const t = setup({ replyAgoMs: 6000, model: { provider: "openai", id: "gpt-6", promptCache: { short: 2 }, cost: {} } });
  await t.emit("input", { text: "x", source: "interactive" });
  check("non-Claude: no dialog", t.state.selects.length === 0);
}

// (5) no automatic summary machinery
{
  const t = setup();
  const registered = [...t.handlers.keys()];
  check("only the input hook is registered", registered.length === 1 && registered[0] === "input", registered.join(","));
  check("no model requests made", t.state.calls === 0);
}

console.log(failed === 0 ? "\nselftest: all checks passed" : `\nselftest: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);

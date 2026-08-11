/**
 * selftest.mjs — auth-free behavioural guard for pa-checker.
 *
 * No model, no token, no network. The checker subprocess is a FAKE `pi` placed
 * first on PATH: index.ts resolves the checker command to bare "pi" whenever it
 * runs under node (piInvocation), so the real spawn path, the real argv, the
 * real JSON-lines stdout parsing and the real timeout all execute — only the
 * model is replaced. That is deliberate: stubbing child_process would have
 * tested a mock of the one part most likely to be wrong.
 *
 * What is actually asserted, in rough order of how bad the regression would be:
 *
 *   1. THE CHECKER CANNOT WRITE. child.ts blocks every non-read-only tool at
 *      execution time, and the spawned argv carries the allowlist and the
 *      denylist. If this regresses, an unattended process gains bash and edit
 *      over the user's real project directory. Everything else here is a
 *      correctness bug; this one is a safety bug.
 *   2. Opted-out models cost nothing — no checker key, no subprocess, ever.
 *   3. The revision loop terminates. A checker that can always demand another
 *      round is an infinite bill; the budget must end in a shipped answer.
 *   4. It fails OPEN. Dead checker model, garbage verdict, crash, timeout: the
 *      user still gets their answer. A verification pass that can block work
 *      when it breaks is worse than none.
 *   5. The auditor is told what actually happened — the payload carries the
 *      system prompt, the request, the tool log and the final answer. Without
 *      the tool log it cannot catch "I ran the tests" when nothing ran, which
 *      is the whole reason this extension exists.
 *   6. session_context follows the session TREE, not file order, so an
 *      abandoned /fork branch is never reported to the auditor as history.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_MODULES = `${PI_ROOT}/node_modules`;

// Count only intervals this extension creates, so a leaked progress ticker is
// visible rather than merely suspected.
let liveIntervals = 0;
const ownedTimers = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const t = realSetInterval(fn, ms, ...rest);
  ownedTimers.add(t);
  liveIntervals++;
  return t;
};
globalThis.clearInterval = (t) => {
  if (ownedTimers.has(t)) {
    ownedTimers.delete(t);
    liveIntervals--;
  }
  return realClearInterval(t);
};

let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
};

const { createJiti } = await import(`${PI_MODULES}/jiti/lib/jiti.mjs`);
const alias = {
  "@earendil-works/pi-tui": `${PI_MODULES}/@earendil-works/pi-tui`,
  "@earendil-works/pi-coding-agent": PI_ROOT,
  // Alias to the file, not the directory: typebox declares only "exports" (no
  // "main"), and jiti's alias bypasses exports resolution. In the image the
  // extension has its own node_modules/typebox and resolves normally.
  typebox: `${PI_MODULES}/typebox/build/index.mjs`,
};
const jiti = createJiti(`file://${HERE}/`, { interopDefault: true, alias, fsCache: false });

const TMP = mkdtempSync(join(tmpdir(), "pa-checker-selftest-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

// --- fake pi on PATH -------------------------------------------------------

const BIN = join(TMP, "bin");
mkdirSync(BIN, { recursive: true });
const ARGV_FILE = join(TMP, "argv.txt");
const RESPONSE_FILE = join(TMP, "response.jsonl");
// Arguments are separated by \034, not newline: the payload argument is itself
// multi-line, and splitting on newline would silently truncate every assertion
// about it to its last line (which is exactly what happened first time round).
writeFileSync(
  join(BIN, "pi"),
  `#!/bin/sh
printf '%s\\034' "$@" > "${ARGV_FILE}"
[ -n "$PA_TEST_FAIL" ] && exit 1
cat "${RESPONSE_FILE}"
`,
);
chmodSync(join(BIN, "pi"), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

/** Make the fake checker answer with `text` as its final assistant message. */
function respondWith(text) {
  rmSync(ARGV_FILE, { force: true });
  writeFileSync(
    RESPONSE_FILE,
    `${JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "x" }] } })}
${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}
`,
  );
}

const { readFileSync, existsSync } = await import("node:fs");
/** The spawned argv, one entry per argument. null when nothing was spawned. */
const argvOf = () => {
  if (!existsSync(ARGV_FILE)) return null;
  const parts = readFileSync(ARGV_FILE, "utf8").split("\u001c");
  parts.pop(); // trailing separator
  return parts;
};

// --- fake agent dir with models.json ---------------------------------------

const AGENT_DIR = join(TMP, "agent");
mkdirSync(AGENT_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
writeFileSync(
  join(AGENT_DIR, "models.json"),
  JSON.stringify({
    providers: {
      audited: {
        baseUrl: "http://localhost:1/v1",
        api: "openai-completions",
        models: [
          { id: "watched", checker: "someprov/auditor" },
          { id: "watched-obj", checker: { model: "someprov/auditor", maxRounds: 3 } },
          { id: "unwatched" },
        ],
        modelOverrides: { "override-watched": { checker: "someprov/auditor" } },
      },
    },
  }),
);

// --- fakes -----------------------------------------------------------------

function fakePi() {
  const handlers = new Map();
  const sent = [];
  const tools = new Map();
  const pi = {
    registerCommand() {},
    registerTool(def) {
      tools.set(def.name, def);
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    on(evt, fn) {
      if (!handlers.has(evt)) handlers.set(evt, []);
      handlers.get(evt).push(fn);
    },
  };
  const emit = async (evt, event, ctx) => {
    const out = [];
    for (const fn of handlers.get(evt) ?? []) out.push(await fn(event, ctx));
    return out;
  };
  return { pi, emit, sent, tools };
}

const msg = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: new Date().toISOString(), message });

/** A finished turn: user asks, model greps, model claims success. */
function defaultEntries() {
  return [
    msg("u1", null, { role: "user", content: "add retry logic and run the tests" }),
    msg("a1", "u1", {
      role: "assistant",
      content: [
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "t1", name: "grep", arguments: { pattern: "retry" } },
      ],
      stopReason: "toolUse",
    }),
    msg("r1", "a1", { role: "toolResult", toolCallId: "t1", toolName: "grep", content: [{ type: "text", text: "no matches" }], isError: false }),
    msg("a2", "r1", { role: "assistant", content: [{ type: "text", text: "Done — I added retries and all tests pass." }], stopReason: "stop" }),
  ];
}

function makeCtx(entries = defaultEntries(), modelId = "watched") {
  const notes = [];
  const widgets = []; // every setWidget call, in order
  return {
    notes,
    widgets,
    cwd: TMP,
    hasUI: true,
    mode: "tui",
    model: { provider: "audited", id: modelId },
    ui: {
      notify: (m, l) => notes.push(`${l}: ${m}`),
      setStatus: () => {},
      setWidget: (_key, content) => widgets.push(content),
    },
    getSystemPrompt: () => "SYSTEM_PROMPT_SENTINEL: never invent results.",
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionFile: () => SESSION_FILE,
      getLeafId: () => "leaf-b",
    },
  };
}

// --- a real session file, with an abandoned branch --------------------------
//
//   u1 ── a1 ── u2 ── a-abandoned      (a /fork the user walked away from)
//               └──── a-leaf           (the branch actually in play)

const SESSION_FILE = join(TMP, "session.jsonl");
writeFileSync(
  SESSION_FILE,
  [
    JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: TMP }),
    JSON.stringify(msg("s-u1", null, { role: "user", content: "MARKER_FIRST_REQUEST" })),
    JSON.stringify(msg("s-a1", "s-u1", { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" })),
    JSON.stringify(msg("s-u2", "s-a1", { role: "user", content: "second" })),
    JSON.stringify(msg("abandoned", "s-u2", { role: "assistant", content: [{ type: "text", text: "MARKER_ABANDONED" }], stopReason: "stop" })),
    JSON.stringify(msg("leaf-b", "s-u2", { role: "assistant", content: [{ type: "text", text: "MARKER_LIVE" }], stopReason: "stop" })),
  ].join("\n"),
);

// ===========================================================================
// 1. The read-only guarantee (child.ts)
// ===========================================================================

const childMod = await jiti.import(`${HERE}/child.ts`);
const childInst = fakePi();
(childMod.default ?? childMod)(childInst.pi);

for (const tool of ["bash", "edit", "write", "apply_patch", "page_console"]) {
  const [res] = await childInst.emit("tool_call", { toolName: tool, input: {} }, {});
  check(`child blocks "${tool}"`, res?.block === true, JSON.stringify(res));
}
for (const tool of ["read", "ls", "find", "grep", "session_context"]) {
  const [res] = await childInst.emit("tool_call", { toolName: tool, input: {} }, {});
  check(`child allows "${tool}"`, res === undefined, JSON.stringify(res));
}
check("child registers session_context", childInst.tools.has("session_context"));

// ===========================================================================
// 2. session_context reads the tree, not the file
// ===========================================================================

process.env.PA_CHECKER_SESSION_FILE = SESSION_FILE;
process.env.PA_CHECKER_LEAF_ID = "leaf-b";

const sessionTool = childInst.tools.get("session_context");
{
  const out = await sessionTool.execute("id", { mode: "transcript" }, undefined, undefined, {});
  const text = out.content[0].text;
  check("session_context returns the live branch", text.includes("MARKER_LIVE"));
  check("session_context omits the abandoned branch", !text.includes("MARKER_ABANDONED"), text);
  check("session_context reaches back to the first request", text.includes("MARKER_FIRST_REQUEST"));

  const search = await sessionTool.execute("id", { mode: "search", query: "marker_first" }, undefined, undefined, {});
  check("session_context search is case-insensitive", search.content[0].text.includes("MARKER_FIRST_REQUEST"));

  const miss = await sessionTool.execute("id", { mode: "search", query: "zzz-not-here" }, undefined, undefined, {});
  check("session_context reports a miss without inventing one", miss.content[0].text.startsWith("No match"));
}
{
  const saved = process.env.PA_CHECKER_SESSION_FILE;
  delete process.env.PA_CHECKER_SESSION_FILE;
  const out = await sessionTool.execute("id", { mode: "transcript" }, undefined, undefined, {});
  check("session_context degrades to a message when no session file", out.content[0].text.includes("No session file"));
  process.env.PA_CHECKER_SESSION_FILE = saved;
}

// ===========================================================================
// 3. The parent hook
// ===========================================================================

const parentMod = await jiti.import(`${HERE}/index.ts`);
const load = () => {
  const inst = fakePi();
  (parentMod.default ?? parentMod)(inst.pi);
  return inst;
};

// --- opted-out model spawns nothing ---
{
  respondWith('{"verdict":"revise","criticism":"should never be seen"}');
  const inst = load();
  const ctx = makeCtx(defaultEntries(), "unwatched");
  await inst.emit("agent_settled", {}, ctx);
  check("model without a checker key spawns nothing", argvOf() === null);
  check("model without a checker key sends nothing", inst.sent.length === 0);
}

// --- pass ---
{
  respondWith('Looks fine to me.\n```json\n{"verdict": "pass"}\n```');
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);
  check("pass verdict injects no message", inst.sent.length === 0);
  check("pass verdict is reported to the user", ctx.notes.some((n) => n.includes("looks good")), ctx.notes.join("|"));

  const argv = argvOf() ?? [];
  const joined = argv.join(" ");
  check("spawned with the read-only allowlist", argv.includes("read,ls,find,grep,session_context"), joined);
  check("spawned with the write denylist", argv.includes("bash,edit,write"), joined);
  check("spawned with -t and -xt", argv.includes("-t") && argv.includes("-xt"));
  check("spawned ephemeral (--no-session)", argv.includes("--no-session"));
  check("spawned without extension discovery", argv.includes("-ne"));
  check("spawned with the configured checker model", argv.includes("someprov/auditor"), joined);
  check("child extension is loaded explicitly", argv.some((a) => a.endsWith("child.ts")), joined);

  const payload = argv[argv.length - 1];
  check("payload carries the system prompt", payload.includes("SYSTEM_PROMPT_SENTINEL"));
  check("payload carries the user request", payload.includes("add retry logic and run the tests"));
  check("payload carries the final answer", payload.includes("all tests pass"));
  check("payload carries the tool log", payload.includes("grep") && payload.includes("no matches"), payload.slice(0, 400));
  check("payload does not claim tools were called when none were", !payload.includes("no tools were called"));
}

// --- REGRESSION: the "oh wow weird" false positive ---
//
// A real transcript. The user asked about the ritonavir disaster, the agent
// researched it with three browse calls and answered, the user reacted "oh wow
// weird", and the agent followed up conversationally. The first version of
// buildPayload sent request="oh wow weird", tools="none", answer=<a page about
// polymorphs> and nothing else — so the checker correctly deduced from those
// false premises that the agent was answering a question nobody asked using
// research it never did, and demanded a revision. The model then burned a turn
// arguing back, correctly, in front of the user.
//
// The window is the bug, not the checker. The payload must carry the earlier
// exchange and must not present "no tools this turn" as if no tool had ever run.
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const conversation = [
    msg("u1", null, { role: "user", content: "hey tell me about the ritonavir disaster" }),
    msg("a1", "u1", {
      role: "assistant",
      content: [
        { type: "text", text: "Looking it up." },
        { type: "toolCall", id: "b1", name: "yousoro_browse", arguments: { url: "https://www.acs.org/" } },
      ],
      stopReason: "toolUse",
    }),
    msg("r1", "a1", { role: "toolResult", toolCallId: "b1", toolName: "yousoro_browse", content: [{ type: "text", text: "Form II …" }], isError: false }),
    msg("a2", "r1", { role: "assistant", content: [{ type: "text", text: "RITONAVIR_ANSWER: Abbott withdrew Norvir in 1998…" }], stopReason: "stop" }),
    msg("u2", "a2", { role: "user", content: "oh wow weird" }),
    msg("a3", "u2", { role: "assistant", content: [{ type: "text", text: "Yeah — cocoa butter has six polymorphs too." }], stopReason: "stop" }),
  ];
  await inst.emit("agent_settled", {}, makeCtx(conversation));
  const payload = (argvOf() ?? []).pop() ?? "";

  check("payload carries the earlier exchange", payload.includes("RITONAVIR_ANSWER"), payload.slice(0, 300));
  check("payload shows the earlier question", payload.includes("tell me about the ritonavir disaster"));
  check("payload shows tools were called earlier", payload.includes("yousoro_browse"));
  check(
    "an empty tool log for this turn is not presented as 'never used tools'",
    /tool call\(s\) were made earlier/.test(payload),
    payload.slice(payload.indexOf("<tool_calls_this_turn>"), payload.indexOf("<tool_calls_this_turn>") + 300),
  );
  check("payload states the excerpt is one turn of a session", payload.includes("ongoing session"));
}

// --- history is bounded, and says so when it drops things ---
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const long = [];
  for (let i = 0; i < 60; i++) {
    long.push(msg(`u${i}`, null, { role: "user", content: `MSG_${i} ${"x".repeat(900)}` }));
    long.push(msg(`a${i}`, `u${i}`, { role: "assistant", content: [{ type: "text", text: `reply ${i}` }], stopReason: "stop" }));
  }
  long.push(msg("uL", null, { role: "user", content: "last question" }));
  long.push(msg("aL", "uL", { role: "assistant", content: [{ type: "text", text: "last answer" }], stopReason: "stop" }));
  await inst.emit("agent_settled", {}, makeCtx(long));
  const payload = (argvOf() ?? []).pop() ?? "";

  check("long history keeps the most recent turns", payload.includes("MSG_59"));
  check("long history drops the oldest", !payload.includes("MSG_0 "), "MSG_0 should have been trimmed");
  check("trimmed history says it was trimmed", payload.includes("earlier messages omitted"));
  check("payload stays within its byte cap", Buffer.byteLength(payload) <= 256 * 1024, String(Buffer.byteLength(payload)));
}

// --- a genuinely first exchange says so, rather than implying missing context ---
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  await inst.emit(
    "agent_settled",
    {},
    makeCtx([
      msg("u1", null, { role: "user", content: "first ever question" }),
      msg("a1", "u1", { role: "assistant", content: [{ type: "text", text: "first ever answer" }], stopReason: "stop" }),
    ]),
  );
  const payload = (argvOf() ?? []).pop() ?? "";
  check("a first exchange is labelled as such", payload.includes("first exchange in the conversation"));
  check("a first exchange with no tools says none were used at all", payload.includes("none earlier in the conversation either"));
}

// --- a turn with no tool calls says so, rather than staying silent ---
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  await inst.emit(
    "agent_settled",
    {},
    makeCtx([
      msg("u1", null, { role: "user", content: "what is 2+2" }),
      msg("a1", "u1", { role: "assistant", content: [{ type: "text", text: "4" }], stopReason: "stop" }),
    ]),
  );
  const payload = (argvOf() ?? []).pop() ?? "";
  check("empty tool log is stated explicitly", payload.includes("no tools were called"));
}

// --- revise, with messy real-world formatting around the JSON ---
{
  respondWith(
    'The agent claims tests pass, but the log shows only a grep.\n\n```json\n{"verdict": "revise", "criticism": "You wrote \\"all tests pass\\" but the tool log contains no test run (only grep {\\"pattern\\": \\"retry\\"}). Either run them or drop the claim."}\n```\nThat is my verdict.',
  );
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);

  check("revise verdict injects exactly one message", inst.sent.length === 1);
  const { message, options } = inst.sent[0] ?? {};
  check("revise triggers a correction turn", options?.triggerTurn === true && options?.deliverAs === "followUp", JSON.stringify(options));
  check("criticism survives nested braces and quotes", message?.content?.includes("no test run"), message?.content);
  check("message is displayed to the user", message?.display === true);
  check("message is attributed to pa-checker", message?.customType === "pa-checker");
  check("message names the checker model", message?.content?.includes("someprov/auditor"));
}

// --- the loop terminates ---
{
  respondWith('{"verdict":"revise","criticism":"still wrong"}');
  const inst = load();
  const ctx = makeCtx();
  // Same anchor entry each time: this is what a model failing to satisfy the
  // checker over and over looks like.
  await inst.emit("agent_settled", {}, ctx);
  await inst.emit("agent_settled", {}, ctx);
  await inst.emit("agent_settled", {}, ctx);
  await inst.emit("agent_settled", {}, ctx);

  const triggered = inst.sent.filter((s) => s.options?.triggerTurn === true).length;
  check("revision turns are bounded by maxRounds", triggered === 1, `triggered ${triggered} turns`);
  const last = inst.sent[inst.sent.length - 1];
  check("exhausted budget ships the answer instead of looping", !last?.options?.triggerTurn, JSON.stringify(last?.options));
  // deliverAs:"nextTurn" would only QUEUE the message: pi emits no
  // message_start/message_end for it, so the criticism stayed invisible until
  // the user's next prompt pulled it onscreen — arriving, confusingly, after a
  // question it predates. No options means "append, persist, emit now".
  check("exhausted criticism is shown immediately, not queued for the next prompt", last?.options?.deliverAs === undefined, JSON.stringify(last?.options));
  check("exhausted budget still shows the criticism", last?.message?.display === true && last.message.content.includes("still wrong"));
  check("exhausted budget says so", last?.message?.content?.includes("budget"), last?.message?.content);
}

// --- REGRESSION: tool results must survive at a useful size and shape ---
//
// The agent defended itself by grepping a cached page and citing lines
// 279/291/293 verbatim. MAX_TOOL_RESULT_CHARS was 400, so the checker saw only
// the early matches and reported the cited lines as fabricated — the evidence
// that settled the question was inside the truncated part. Worse,
// replace(/\s+/g," ") collapsed newlines, destroying the line structure needed
// to check a "line N says X" claim at all.
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const grepOut = [
    "35: ritonavir is an antiretroviral",
    "156: pharmacodynamics section",
    "161: Ki values and binding",
    ...Array.from({ length: 60 }, (_, i) => `${170 + i}: filler line about chemistry ${"y".repeat(40)}`),
    '279: The US Food and Drug Administration (FDA) approved ritonavir on March 1, 1996',
    '291: It has been estimated that Abbott lost more than US$250 million as a result',
    '293: replacing the capsule formulation with a refrigerated gelcap',
  ].join("\n");

  await inst.emit(
    "agent_settled",
    {},
    makeCtx([
      msg("u1", null, { role: "user", content: "tell me about the ritonavir disaster" }),
      msg("a1", "u1", {
        role: "assistant",
        content: [{ type: "toolCall", id: "g1", name: "bash", arguments: { command: "grep -n polymorph /tmp/cache.txt" } }],
        stopReason: "toolUse",
      }),
      msg("r1", "a1", { role: "toolResult", toolCallId: "g1", toolName: "bash", content: [{ type: "text", text: grepOut }], isError: false }),
      msg("a2", "r1", { role: "assistant", content: [{ type: "text", text: "Every claim is sourced: L279, L291, L293." }], stopReason: "stop" }),
    ]),
  );
  const payload = (argvOf() ?? []).pop() ?? "";

  check("a long tool result is not cut at 400 chars", payload.includes("279: The US Food and Drug Administration"), `grep output was ${grepOut.length} chars`);
  check("the cited evidence lines all survive", payload.includes("291: It has been estimated") && payload.includes("293: replacing the capsule"));
  check("line structure is preserved, not collapsed to a blob", payload.includes("161: Ki values and binding\n"), "newlines were collapsed");
}

// Truncation still happens for genuinely huge results — but it must announce
// itself, and tell the auditor not to read absence into it.
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const huge = `HEAD_MARKER\n${"z".repeat(50_000)}\nTAIL_MARKER`;
  await inst.emit(
    "agent_settled",
    {},
    makeCtx([
      msg("u1", null, { role: "user", content: "read the file" }),
      msg("a1", "u1", { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/big" } }], stopReason: "toolUse" }),
      msg("r1", "a1", { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: huge }], isError: false }),
      msg("a2", "r1", { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }),
    ]),
  );
  const payload = (argvOf() ?? []).pop() ?? "";
  check("a huge tool result is still truncated", !payload.includes("z".repeat(45_000)));
  check("truncation keeps the START of the result", payload.includes("HEAD_MARKER"));
  // Search output quotes what it found LAST, so head-only truncation loses
  // exactly the evidence a late citation rests on. Both ends are kept.
  check("truncation keeps the END of the result", payload.includes("TAIL_MARKER"));
  check("truncation announces itself loudly", payload.includes("[TRUNCATED:"));
  check("truncation says it dropped the MIDDLE", /omitted from the MIDDLE/.test(payload));
  check("truncation warns against reading absence into it", /not thereby absent/.test(payload), payload.slice(payload.indexOf("[TRUNCATED:"), payload.indexOf("[TRUNCATED:") + 260));
  check("payload still respects its overall cap", Buffer.byteLength(payload) <= 256 * 1024);
}

// The prompt must forbid the category error behind every false positive so far:
// treating "I cannot verify this" as "this is false".
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  await inst.emit("agent_settled", {}, makeCtx());
  const argv = argvOf() ?? [];
  const systemPrompt = argv[argv.indexOf("--system-prompt") + 1] ?? "";
  check("auditor is told unverifiable is not a finding", /IS NOT A FINDING/.test(systemPrompt));
  check("auditor is told it can open what the agent opened", /open anything the agent could/i.test(systemPrompt));
  check("auditor is told truncated is not empty", /Truncated is not empty/i.test(systemPrompt));
  // Tone: this thing talks to the model on every revision and its words end up
  // in front of the user. It should read as a colleague, not a prosecutor.
  check("auditor is framed as a colleague, not a judge", /colleague/i.test(systemPrompt) && /not to sit in judgement/i.test(systemPrompt));
  check("auditor is told most answers are fine", /Most answers are fine/i.test(systemPrompt));
  check("auditor is told to assume good faith", /good faith/i.test(systemPrompt));

  // Recall floor. Tuning against false positives cost a real one: an English
  // "hi" answered in Chinese, breaking an explicit rule in the very system
  // prompt the reviewer was handed, came back "looks good". The tone stays; the
  // carve-outs must not swallow rules the user actually wrote down.
  check("reply language is named as a checkable rule", /WHAT LANGUAGE TO REPLY IN/i.test(systemPrompt));
  check("replying in the wrong language is called a real violation", /not a stylistic quibble/i.test(systemPrompt));
  check("the style carve-out is limited to the reviewer's OWN taste", /YOUR style and taste/.test(systemPrompt));
  check("a written-down rule is excluded from 'taste'", /is not a matter of taste/i.test(systemPrompt));
  check("'only a small thing' is refused as a reason to pass", /only a small thing/i.test(systemPrompt));
  check("chat turns are still bound by the system prompt", /does not suspend the rules/i.test(systemPrompt));
  check("compliance must be enumerated, not felt", /Do not judge this by feel/i.test(systemPrompt));
  check("the verdict contract asks what was checked", /"checked"/.test(systemPrompt));
}

// --- `checked` is captured and surfaced -----------------------------------
{
  respondWith('{"verdict":"pass","checked":["reply language matches the user\'s","no claims about files"]}');
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);
  const note = ctx.notes.join("|");
  check("a passing review reports what it checked", /checked: reply language matches the user's, no claims about files/.test(note), note);
}
{
  // A reviewer that omits the list must still produce a usable verdict — the
  // forcing function is a nudge, not a new way to fail.
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);
  check("a pass without a checked list still passes", ctx.notes.some((n) => n.includes("looks good")) && inst.sent.length === 0, ctx.notes.join("|"));
}
{
  respondWith('{"verdict":"revise","checked":["reply language"],"criticism":"The user wrote in English; the reply is in Chinese."}');
  const inst = load();
  await inst.emit("agent_settled", {}, makeCtx());
  const { message } = inst.sent[0] ?? {};
  check("what was checked is recorded on the message", Array.isArray(message?.details?.checked) && message.details.checked[0] === "reply language", JSON.stringify(message?.details));
  check("the criticism itself still comes through", message?.content?.includes("the reply is in Chinese"));
}
{
  // Junk in `checked` must not crash or leak into the notification.
  respondWith('{"verdict":"pass","checked":[null,42,"  ","language"]}');
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);
  check("a malformed checked list is filtered, not fatal", ctx.notes.some((n) => n.includes("checked: language")), ctx.notes.join("|"));
}

// --- REGRESSION: the checker must see its OWN previous objection ---
//
// Round 2 audits the model's response to round 1. That response is a reply to
// the checker, and a custom message is neither "user" nor "assistant", so the
// first version dropped it: the auditor saw a reply refuting objections that,
// as far as it could tell, nobody had made, and called it a hallucinated
// critique. The checker attacked the model for answering the checker.
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const afterRound1 = [
    msg("u1", null, { role: "user", content: "oh wow weird" }),
    msg("a1", "u1", { role: "assistant", content: [{ type: "text", text: "ORIGINAL_ANSWER about cocoa butter" }], stopReason: "stop" }),
    msg("c1", "a1", {
      role: "custom",
      customType: "pa-checker",
      content: "OBJECTION_TEXT: no tool calls recorded, assumes prior conversation",
      display: true,
    }),
    msg("a2", "c1", { role: "assistant", content: [{ type: "text", text: "REBUTTAL: the objection is wrong because the tool calls are in the log" }], stopReason: "stop" }),
  ];
  await inst.emit("agent_settled", {}, makeCtx(afterRound1));
  const payload = (argvOf() ?? []).pop() ?? "";

  check("payload contains the checker's own earlier objection", payload.includes("OBJECTION_TEXT"), payload.slice(0, 400));
  check("the objection is attributed to the audit, not to the user", payload.includes("VERIFICATION PASS"));
  check("payload keeps the superseded answer", payload.includes("ORIGINAL_ANSWER"));
  check("the rebuttal is what gets judged", payload.includes("<final_answer_to_the_user>\nREBUTTAL"), payload.slice(-400));
}

// A turn nobody interrupted carries no such section, rather than an empty one.
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  await inst.emit("agent_settled", {}, makeCtx());
  const payload = (argvOf() ?? []).pop() ?? "";
  check("a clean turn has no what_happened_since_then section", !payload.includes("what_happened_since_then"));
}

// --- a new request resets the budget ---
{
  respondWith('{"verdict":"revise","criticism":"nope"}');
  const inst = load();
  await inst.emit("agent_settled", {}, makeCtx());
  await inst.emit("agent_settled", {}, makeCtx());
  const entries = defaultEntries();
  entries.push(msg("u2", "a2", { role: "user", content: "different question" }));
  entries.push(msg("a3", "u2", { role: "assistant", content: [{ type: "text", text: "different answer" }], stopReason: "stop" }));
  await inst.emit("agent_settled", {}, makeCtx(entries));
  const triggered = inst.sent.filter((s) => s.options?.triggerTurn === true).length;
  check("a new user request gets a fresh budget", triggered === 2, `triggered ${triggered}`);
}

// --- fail open ---
{
  respondWith('{"verdict":"revise","criticism":"unreachable"}');
  process.env.PA_TEST_FAIL = "1";
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);
  delete process.env.PA_TEST_FAIL;
  check("dead checker injects nothing", inst.sent.length === 0);
  check("dead checker warns instead of failing silently", ctx.notes.some((n) => n.startsWith("warning:")), ctx.notes.join("|"));
}
{
  respondWith("I think it is probably fine, honestly.");
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);
  check("unparseable verdict injects nothing", inst.sent.length === 0);
  check("unparseable verdict warns", ctx.notes.some((n) => n.includes("unparseable")), ctx.notes.join("|"));
}

// --- delivering the criticism must not be able to kill pi ---
//
// pi.sendMessage() with triggerTurn resolves only when the WHOLE correction
// turn has finished, so it is floated rather than awaited (awaiting would hold
// the re-entrancy guard across the nested agent_settled and silently disable
// round 2). A floated promise that rejects is an unhandled rejection, which
// terminates node by default — a verification pass must never be able to do
// that to the session it is checking.
{
  respondWith('{"verdict":"revise","criticism":"deliver me"}');
  let unhandled = null;
  const onUnhandled = (e) => {
    unhandled = e;
  };
  process.on("unhandledRejection", onUnhandled);

  const inst = load();
  inst.pi.sendMessage = () => Promise.reject(new Error("correction turn blew up"));
  const ctx = makeCtx();
  const started = Date.now();
  await inst.emit("agent_settled", {}, ctx);
  const elapsed = Date.now() - started;

  await new Promise((r) => setTimeout(r, 50)); // let the rejection surface
  process.off("unhandledRejection", onUnhandled);

  check("a failed delivery does not become an unhandled rejection", unhandled === null, String(unhandled));
  check("a failed delivery is reported", ctx.notes.some((n) => n.includes("could not deliver")), ctx.notes.join("|"));
  check("the handler does not block on the correction turn", elapsed < 10_000, `${elapsed}ms`);
}

// --- things that must never be audited ---
{
  respondWith('{"verdict":"revise","criticism":"should never run"}');
  const inst = load();
  const aborted = defaultEntries();
  aborted[aborted.length - 1].message.stopReason = "aborted";
  await inst.emit("agent_settled", {}, makeCtx(aborted));
  check("an interrupted answer is not audited", argvOf() === null && inst.sent.length === 0);
}
{
  respondWith('{"verdict":"revise","criticism":"should never run"}');
  const inst = load();
  await inst.emit("agent_settled", {}, makeCtx([msg("u1", null, { role: "user", content: "hi" })]));
  check("a turn with no answer yet is not audited", argvOf() === null && inst.sent.length === 0);
}

// --- modelOverrides is honoured (ctx.model.checker alone would miss it) ---
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  await inst.emit("agent_settled", {}, makeCtx(defaultEntries(), "override-watched"));
  check("checker in modelOverrides is found", argvOf() !== null);
}
// --- object form ---
{
  respondWith('{"verdict":"revise","criticism":"x"}');
  const inst = load();
  const ctx = makeCtx(defaultEntries(), "watched-obj");
  for (let i = 0; i < 5; i++) await inst.emit("agent_settled", {}, ctx);
  const triggered = inst.sent.filter((s) => s.options?.triggerTurn === true).length;
  check("object form honours its own maxRounds", triggered === 2, `triggered ${triggered}`);
}

// ===========================================================================
// 4. The audit is visible while it runs
// ===========================================================================
//
// agent_settled fires AFTER the answer is printed, so the transcript looks
// finished and pi is silently blocked awaiting this handler. Without a visible
// indicator the user starts typing and the verdict lands on top of them.
{
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);

  check("a widget is shown while the audit runs", ctx.widgets.length >= 2, `${ctx.widgets.length} widget calls`);
  const shown = ctx.widgets[0];
  check("the running widget names the checker model", Array.isArray(shown) && shown.join(" ").includes("someprov/auditor"), JSON.stringify(shown));
  check("the running widget says it is not the user's turn", Array.isArray(shown) && /not your turn/i.test(shown.join(" ")), JSON.stringify(shown));
  check("the widget is cleared when the audit finishes", ctx.widgets[ctx.widgets.length - 1] === undefined, JSON.stringify(ctx.widgets[ctx.widgets.length - 1]));
}
{
  // ...and cleared on every exit path, not just the happy one.
  respondWith('{"verdict":"revise","criticism":"x"}');
  process.env.PA_TEST_FAIL = "1";
  const inst = load();
  const ctx = makeCtx();
  await inst.emit("agent_settled", {}, ctx);
  delete process.env.PA_TEST_FAIL;
  check("the widget is cleared when the checker fails", ctx.widgets[ctx.widgets.length - 1] === undefined);
}
{
  // The progress ticker must not outlive the audit. A leaked interval that
  // later touches a replaced session's ctx.ui is exactly how pa-anthropic-oauth
  // used to kill pi on /resume (docs/testing.md).
  const before = liveIntervals;
  respondWith('{"verdict":"pass"}');
  const inst = load();
  await inst.emit("agent_settled", {}, makeCtx());
  check("the progress ticker is not leaked", liveIntervals === before, `${liveIntervals - before} interval(s) left running`);
}
{
  // A stale ctx must not throw out of the timer callback: that is an
  // uncaughtException with nothing to catch it.
  respondWith('{"verdict":"pass"}');
  const inst = load();
  const ctx = makeCtx();
  let stale = false;
  Object.defineProperty(ctx, "ui", {
    get() {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return { notify: (m, l) => ctx.notes.push(`${l}: ${m}`), setStatus: () => {}, setWidget: () => {} };
    },
  });
  const pending = inst.emit("agent_settled", {}, ctx);
  stale = true; // session replaced mid-audit
  await pending;
  check("a session replaced mid-audit does not throw out of the handler", true);
}

console.log(failed === 0 ? "selftest: all checks passed" : `selftest: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

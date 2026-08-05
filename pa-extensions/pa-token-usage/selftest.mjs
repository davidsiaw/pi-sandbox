/**
 * selftest.mjs — auth-free guard for pa-token-usage.
 *
 * Unlike pa-screenshot's selftest this one DOES load index.ts (through pi's
 * bundled jiti), because the extension needs no model and no auth: it only
 * listens to two events and writes a file. So the real handlers are driven
 * with fake events and the resulting CSV is asserted.
 *
 * Guards the things most likely to break silently:
 *   (1) the CSV row matches the header, column for column;
 *   (2) cost 0 (local models, subscription billing) yields an EMPTY
 *       tokens_per_cent instead of Infinity/NaN poisoning the file;
 *   (3) the header is written exactly once even when many writers race, and
 *       no row is torn or lost -- this is the whole reason for O_APPEND;
 *   (4) a nested tool usage produces its own row tagged tool:<name>;
 *   (5) writes land under $PI_CODING_AGENT_DIR, so the real run lands in the
 *       host-mounted ~/.pi/agent/extensions/... and survives the container.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, cond, detail) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
	}
}

// --- Load index.ts via pi's own jiti ---------------------------------------
// pi is installed globally and is not on NODE_PATH, so resolve jiti from inside
// the pi package rather than from here.
const PI_PKG = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(join(PI_PKG, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);

const SANDBOX = mkdtempSync(join(tmpdir(), "pa-token-usage-"));
process.env.PI_CODING_AGENT_DIR = SANDBOX;

const mod = await jiti.import(join(HERE, "index.ts"), { default: true });
check("index.ts loads and default-exports a function", typeof mod === "function");

// --- Drive the extension with a mock pi ------------------------------------
const handlers = new Map();
const notices = [];
const pi = { on: (event, fn) => handlers.set(event, fn) };
mod(pi);

check("subscribes to message_end", handlers.has("message_end"));
check("subscribes to tool_result", handlers.has("tool_result"));

const ctx = {
	ui: { notify: (m, level) => notices.push([level, m]) },
	sessionManager: {
		getSessionId: () => "sess-abc",
		buildContextEntries: () => [{ role: "user", content: "hello world" }],
	},
};

// Shape copied from a REAL anthropic-oauth row in .pi-sessions: input is
// literally 2 because everything real arrives as cacheRead/cacheWrite.
const paidMessage = {
	role: "assistant",
	provider: "anthropic-oauth",
	model: "claude-opus-5",
	stopReason: "stop",
	timestamp: Date.parse("2026-08-05T12:00:00.000Z"),
	content: [{ type: "text", text: "hi" }],
	usage: {
		input: 2,
		output: 330,
		cacheRead: 0,
		cacheWrite: 9509,
		totalTokens: 9841,
		cost: { input: 0.00001, output: 0.00825, cacheRead: 0, cacheWrite: 0.05943125, total: 0.06769125 },
	},
};

// Local model: every cost is 0. tokens_per_cent must not become Infinity.
const freeMessage = {
	...paidMessage,
	provider: "m5-max",
	model: "Qwen3.6-27B-oQ6-fp16-mtp",
	usage: {
		input: 417, output: 51, cacheRead: 6144, cacheWrite: 0, totalTokens: 6612,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

await handlers.get("message_end")({ message: paidMessage }, ctx);
await handlers.get("message_end")({ message: freeMessage }, ctx);
await handlers.get("message_end")({ message: { role: "user", content: "x" } }, ctx);
await handlers.get("tool_result")(
	{
		toolName: "inspect_image",
		content: [{ type: "text", text: "a cat" }],
		usage: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 1240, cost: { total: 0 } },
	},
	ctx,
);
await handlers.get("tool_result")({ toolName: "bash", content: [] }, ctx);

// --- Assert the file ---------------------------------------------------------
const day = (() => {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const csvPath = join(SANDBOX, "extensions", "pa-token-usage", "token-usage", `${day}.csv`);

check("writes under $PI_CODING_AGENT_DIR/extensions/pa-token-usage/token-usage", existsSync(csvPath), csvPath);
check("no warning was emitted", notices.length === 0, JSON.stringify(notices));

const lines = readFileSync(csvPath, "utf8").trim().split("\n");
const header = lines[0].split(",");
check("exactly 3 rows written (2 assistant + 1 nested; user + usage-less tool skipped)", lines.length === 4, `got ${lines.length - 1}`);

const col = (line, name) => line.split(",")[header.indexOf(name)];

check("paid row: model recorded", col(lines[1], "model") === "claude-opus-5");
check("paid row: raw counters preserved (input really is 2)", col(lines[1], "tokens_in") === "2");
check("paid row: cache_write recorded", col(lines[1], "tokens_cache_write") === "9509");
check("paid row: cost_total recorded", col(lines[1], "cost_total") === "0.06769125");
check(
	"paid row: tokens_per_cent = total/(cost*100)",
	col(lines[1], "tokens_per_cent") === (9841 / (0.06769125 * 100)).toFixed(2),
	col(lines[1], "tokens_per_cent"),
);
check("paid row: bytes_in non-empty", Number(col(lines[1], "bytes_in")) > 0);
check("paid row: bytes_out non-empty", Number(col(lines[1], "bytes_out")) > 0);
check("paid row: kind=assistant", col(lines[1], "kind") === "assistant");

check("free row: cost 0 leaves tokens_per_cent EMPTY, not Infinity", col(lines[2], "tokens_per_cent") === "");
check("free row: model recorded", col(lines[2], "model") === "Qwen3.6-27B-oQ6-fp16-mtp");

check("nested row: tagged with tool name", col(lines[3], "kind") === "tool:inspect_image");
check("nested row: tokens recorded", col(lines[3], "tokens_total") === "1240");

check("every row has same column count as header", lines.every((l) => l.split(",").length === header.length));

// --- Concurrency: the reason this uses O_APPEND ------------------------------
// Spawn N processes that each append M rows to the SAME file, exactly as N
// containers sharing the host mount would. Every row must survive intact and
// the header must appear exactly once.
const N = 8;
const M = 40;
const raceDir = mkdtempSync(join(tmpdir(), "pa-token-usage-race-"));
const child = `
process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(raceDir)};
const { createRequire } = require("node:module");
const req = createRequire(${JSON.stringify(join(PI_PKG, "package.json"))});
const { createJiti } = req("jiti");
const jiti = createJiti(${JSON.stringify(import.meta.url)});
(async () => {
  const mod = await jiti.import(${JSON.stringify(join(HERE, "index.ts"))}, { default: true });
  const handlers = new Map();
  mod({ on: (e, f) => handlers.set(e, f) });
  const ctx = { ui: { notify(){} }, sessionManager: { getSessionId: () => process.argv[2], buildContextEntries: () => [] } };
  const msg = ${JSON.stringify(paidMessage)};
  for (let i = 0; i < ${M}; i++) await handlers.get("message_end")({ message: msg }, ctx);
})();
`;
const kids = [];
for (let i = 0; i < N; i++) {
	kids.push(
		new Promise((resolve) => {
			try {
				execFileSync(process.execPath, ["-e", child, `w${i}`], { stdio: "ignore" });
			} catch {}
			resolve();
		}),
	);
}
await Promise.all(kids);

const racePath = join(raceDir, "extensions", "pa-token-usage", "token-usage", `${day}.csv`);
const raceLines = readFileSync(racePath, "utf8").trim().split("\n");
const headerCount = raceLines.filter((l) => l.startsWith("ts_iso,")).length;
const bad = raceLines.filter((l, i) => i > 0 && l.split(",").length !== header.length);

check(`concurrency: all ${N * M} rows present, none lost`, raceLines.length === N * M + 1, `got ${raceLines.length - 1}`);
check("concurrency: header written exactly once despite the race", headerCount === 1, `got ${headerCount}`);
check("concurrency: no torn/interleaved rows", bad.length === 0, `${bad.length} malformed`);

rmSync(SANDBOX, { recursive: true, force: true });
rmSync(raceDir, { recursive: true, force: true });

console.log(failed === 0 ? "\nselftest: all checks passed" : `\nselftest: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);

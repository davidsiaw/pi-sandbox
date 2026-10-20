/**
 * selftest.mjs — auth-free guard for pa-server-context.
 *
 * Loads index.ts through pi's bundled jiti and drives its real handlers with a
 * mock pi, against loopback servers that answer GET /v1/models the way real ones
 * do: llama.cpp (and LMD/tqserve) with meta.n_ctx, vLLM (and omlx, SGLang) with
 * max_model_len, a one-model server listing its model under another name with
 * context_length (OpenRouter's field), and a server that is down.
 *
 * Guards:
 *   (1) each models.json model gets the context its server reports, from
 *       whichever conventional field it uses, and maxTokens no larger than it;
 *   (2) the provider's own API key goes with the request;
 *   (3) a model its server does not list keeps its contextWindow, unless the
 *       server serves exactly one model, which is then the one;
 *   (4) providers not in models.json (pi's built-ins) are never asked;
 *   (5) before each prompt only the current model's provider is asked again, and
 *       it is re-registered only when the context changed;
 *   (6) a server that is down throws nothing and changes nothing.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
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

const asked = { llama: 0, vllm: 0, single: 0 };
const auth = [];
function server(name, body) {
	return new Promise((resolve) => {
		const s = createServer((req, res) => {
			if (req.url !== "/v1/models") return res.writeHead(404).end();
			asked[name]++;
			auth.push([name, req.headers.authorization]);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body()));
		});
		s.listen(0, "127.0.0.1", () => resolve(s));
	});
}

let llamaContext = 32768;
const llama = await server("llama", () => ({
	data: [{ id: "tqllm", object: "model", meta: { n_ctx: llamaContext, n_ctx_train: 262144 } }],
}));
const vllm = await server("vllm", () => ({
	data: [{ id: "a", max_model_len: 262144 }, { id: "b", max_model_len: 131072 }],
}));
const single = await server("single", () => ({ data: [{ id: "some-file.gguf", context_length: 65536 }] }));
const url = (s) => `http://127.0.0.1:${s.address().port}/v1`;

// models.json, as the user writes it, in a scratch agent dir
const AGENT = mkdtempSync(join(tmpdir(), "pa-server-context-"));
process.env.PI_CODING_AGENT_DIR = AGENT;
const providers = {
	"llama-cpp": { baseUrl: url(llama), api: "openai-completions", apiKey: "secret", models: [{ id: "tqllm" }] },
	omlx: { baseUrl: url(vllm), api: "openai-completions", apiKey: "none", models: [{ id: "a" }, { id: "b" }, { id: "c" }] },
	single: { baseUrl: url(single), api: "openai-completions", apiKey: "none", models: [{ id: "whatever" }] },
	down: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "x" }] },
};
writeFileSync(join(AGENT, "models.json"), JSON.stringify({ providers }));

// the registry pi composes from it, plus a built-in provider
const model = (provider, id) => ({
	id, name: id, provider, baseUrl: providers[provider]?.baseUrl ?? "https://openrouter.ai/api/v1",
	api: "openai-completions", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 196608, maxTokens: 65536,
});
const declared = [
	model("llama-cpp", "tqllm"), model("omlx", "a"), model("omlx", "b"), model("omlx", "c"),
	model("single", "whatever"), model("down", "x"), model("openrouter", "some/model"),
];

const PI_PKG = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(join(PI_PKG, "package.json"));
const { createJiti } = require("jiti");
const mod = await createJiti(import.meta.url).import(join(HERE, "index.ts"), { default: true });
check("index.ts loads and default-exports a function", typeof mod === "function");

const handlers = new Map();
const calls = [];
const pi = {
	on: (event, fn) => handlers.set(event, fn),
	registerProvider: (name, config) => calls.push(["register", name, config]),
	unregisterProvider: (name) => calls.push(["unregister", name]),
};
const ctx = {
	model: declared[0],
	modelRegistry: {
		getAll: () => declared,
		getApiKeyAndHeaders: async (m) => ({ ok: true, apiKey: providers[m.provider]?.apiKey }),
	},
};
mod(pi);
const fire = (event) => handlers.get(event)?.({ type: event }, ctx);
const registered = (name) => calls.filter((c) => c[0] === "register" && c[1] === name).map((c) => c[2].models);
const windows = (models) => Object.fromEntries((models ?? []).map((m) => [m.id, m.contextWindow]));

// (1)-(4)
await fire("session_start");
const lmd = registered("llama-cpp")[0];
check("llama.cpp convention: meta.n_ctx", windows(lmd).tqllm === 32768, JSON.stringify(windows(lmd)));
check("maxTokens no larger than the context", lmd?.[0]?.maxTokens === 32768, String(lmd?.[0]?.maxTokens));
check("the rest of the model as declared", lmd?.[0]?.reasoning === true && lmd?.[0]?.baseUrl === url(llama));
const om = registered("omlx")[0];
check("vLLM convention: max_model_len, per model", windows(om).a === 262144 && windows(om).b === 131072,
	JSON.stringify(windows(om)));
check("a model the server does not list keeps its context", windows(om).c === 196608);
check("a one-model server's model is the one, by any name: context_length",
	windows(registered("single")[0]).whatever === 65536, JSON.stringify(windows(registered("single")[0])));
check("the provider's API key goes with the request", auth.some(([n, a]) => n === "llama" && a === "Bearer secret"),
	JSON.stringify(auth));
check("a server that is down changes nothing", registered("down").length === 0);
check("built-in providers are never asked", !calls.some((c) => c[1] === "openrouter"));
check("drops its override before registering", calls.findIndex((c) => c[0] === "unregister" && c[1] === "llama-cpp") <
	calls.findIndex((c) => c[0] === "register" && c[1] === "llama-cpp"));

// (5)
calls.length = 0;
const vllmAsked = asked.vllm;
await fire("before_agent_start");
check("no re-registration when the context is unchanged", calls.filter((c) => c[0] === "register").length === 0);
llamaContext = 65536;
await fire("before_agent_start");
check("follows a new context before the next prompt", windows(registered("llama-cpp")[0]).tqllm === 65536);
check("asks only the current model's server before a prompt", asked.vllm === vllmAsked, `${vllmAsked} -> ${asked.vllm}`);

// (6)
calls.length = 0;
ctx.model = declared[5];
let threw = false;
try {
	await fire("before_agent_start");
} catch {
	threw = true;
}
check("a server that is down throws nothing", !threw && calls.length === 0);

for (const s of [llama, vllm, single]) s.close();
if (failed) {
	console.log(`selftest: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("selftest: all checks passed");

/**
 * pa-server-context — models.json models get the context window their server reports.
 *
 * pi takes a models.json model's contextWindow as written (128000 when left out)
 * and never asks the server. But local servers decide the context when they load
 * a model, from the GPU and what else uses it, and they say what it is at the
 * OpenAI-standard GET /v1/models, each model's entry carrying it under the field
 * of its server's convention:
 *
 *   meta.n_ctx          llama.cpp's llama-server (and servers modelled on it: LMD, tqserve)
 *   max_model_len       vLLM (and SGLang, omlx)
 *   context_length      OpenRouter's catalog field, used by several gateways
 *   meta.n_ctx_train    llama.cpp, the trained context, when nothing above is there
 *
 * So, for every provider declared in models.json, it asks that server and gives
 * each model the context it reports, maxTokens capped at it. Nothing to configure.
 *
 * WHICH ENTRY
 *   The entry with the model's id. Failing that, when the server serves exactly
 *   one model, that one: a single-model server (llama-server, LMD) may call its
 *   model something else than models.json does, but it can only mean that one.
 *   A model its server does not report keeps what models.json says.
 *
 * WHEN
 *   Every provider at session start; the current model's provider again before
 *   each prompt and when a model is selected, so a server that reloads with
 *   another context is followed. It re-registers a provider only when a context
 *   changed. pi's built-in providers are never asked: their catalog knows.
 *
 * HOW
 *   pi.registerProvider() with the provider's models as declared and the
 *   reported contexts; pi then refreshes the current model, so compaction and the
 *   context gauge follow at once. It drops its own registration first each time,
 *   so the models start from models.json as it is now and edits still apply. The
 *   request carries the provider's own API key and headers.
 *
 * FAILURE POLICY
 *   Never break a turn: a server that does not answer in time, or answers
 *   something else, changes nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 3000;

/** Same resolution as pa-checker: the agent dir the pa launcher mounts. */
function declaredProviders(): Set<string> {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	try {
		const config = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"));
		return new Set(Object.keys(config?.providers ?? {}));
	} catch {
		return new Set();
	}
}

/** The context a /v1/models entry reports, by the conventions above, in order. */
function reportedContext(entry: any): number | undefined {
	const candidates = [entry?.meta?.n_ctx, entry?.max_model_len, entry?.context_length, entry?.meta?.n_ctx_train];
	return candidates.find((value) => Number.isSafeInteger(value) && value > 0);
}

export default function (pi: ExtensionAPI) {
	// provider -> model id -> context last applied
	const applied = new Map<string, Map<string, number>>();
	let declared = new Set<string>();

	function modelsOf(ctx: ExtensionContext, provider: string): any[] {
		return ctx.modelRegistry.getAll().filter((m: any) => m.provider === provider && (m.type ?? "chat") === "chat");
	}

	/** The server's /v1/models entries, or undefined when it does not answer with a list. */
	async function serverModels(ctx: ExtensionContext, model: any): Promise<any[] | undefined> {
		try {
			const auth: any = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			const headers: Record<string, string> = { ...(auth?.ok ? auth.headers : {}) };
			if (auth?.ok && auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
			const base = String((auth?.ok && auth.baseUrl) || model.baseUrl).replace(/\/+$/, "");
			const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
			if (!response.ok) return undefined;
			const body: any = await response.json();
			return Array.isArray(body?.data) ? body.data : undefined;
		} catch {
			return undefined;
		}
	}

	async function update(ctx: ExtensionContext, provider: string) {
		const models = modelsOf(ctx, provider);
		if (models.length === 0 || models[0].api !== "openai-completions") return;
		const entries = await serverModels(ctx, models[0]);
		if (!entries) return;

		const contexts = new Map<string, number>();
		for (const model of models) {
			const entry = entries.find((e) => e?.id === model.id) ?? (entries.length === 1 ? entries[0] : undefined);
			const context = reportedContext(entry);
			if (context) contexts.set(model.id, context);
		}
		const before = applied.get(provider);
		const changed = [...contexts].some(([id, context]) => before?.get(id) !== context);
		if (contexts.size === 0 || !changed) return;

		pi.unregisterProvider(provider);
		const current = modelsOf(ctx, provider).map((model) => {
			const context = contexts.get(model.id);
			return context
				? { ...model, contextWindow: context, maxTokens: Math.min(model.maxTokens ?? context, context) }
				: model;
		});
		pi.registerProvider(provider, { models: current } as any);
		applied.set(provider, contexts);
	}

	async function updateCurrent(ctx: ExtensionContext) {
		const provider = (ctx.model as any)?.provider;
		if (provider && declared.has(provider)) await update(ctx, provider);
	}

	pi.on("session_start", async (_event, ctx) => {
		declared = declaredProviders();
		applied.clear();
		await Promise.all([...declared].map((provider) => update(ctx, provider)));
	});
	pi.on("before_agent_start", async (_event, ctx) => updateCurrent(ctx));
	pi.on("model_select", async (_event, ctx) => updateCurrent(ctx));
}

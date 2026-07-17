/**
 * pi-inspect-image (pa baked extension)
 *
 * Registers an `inspect_image` tool that lets the active agent ask a separate
 * vision-capable model to inspect an image — useful when the main chat model
 * is not a VLM.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOTHING IS HARDCODED. All model configuration comes from pi's own config:
 *   - which models exist / their baseUrl / api / auth  → models.json (registry)
 *   - which model to use for vision                     → settings.json
 *
 * The vision model is chosen, in order:
 *   1. settings.json  "visionModel": "provider/model-id"   (project then global)
 *   2. settings.json  "visionConfig": { "provider", "model" }  (legacy shape)
 *   3. auto-pick the first image-capable model the registry reports
 *
 * The tool resolves the model through pi's model registry, so the provider's
 * baseUrl, api flavour, and auth all come from models.json / settings — this
 * extension never embeds an endpoint, model name, or provider.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

// Photon (Rust/WASM) — the same image library pi uses internally. Pure WASM,
// no native build, decodes webp/jpeg/gif/bmp/png and re-encodes to PNG.
// Installed into this extension's own node_modules at image-build time.
import photon from "@silvia-odwyer/photon-node";

// ── Config resolution (settings-driven, no hardcoded values) ────────────────

/** Read a `provider/model-id` vision reference from a settings.json object. */
function readVisionRef(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const settings = raw as Record<string, unknown>;

	// Preferred: flat "visionModel": "provider/model-id"
	if (typeof settings.visionModel === "string" && settings.visionModel.includes("/")) {
		return settings.visionModel;
	}

	// Legacy: "visionConfig": { provider, model }
	const vc = settings.visionConfig;
	if (typeof vc === "object" && vc !== null) {
		const { provider, model } = vc as Record<string, unknown>;
		if (typeof model === "string") {
			if (model.includes("/")) return model;
			if (typeof provider === "string") return `${provider}/${model}`;
		}
	}
	return undefined;
}

/** Candidate settings.json paths, project first then global. */
function settingsPaths(cwd: string): string[] {
	const paths = [join(cwd, ".pi", "settings.json")];
	const home = homedir();
	if (home) paths.push(join(home, ".pi", "agent", "settings.json"));
	return paths;
}

/** Resolve the configured vision model ref from settings, if any. */
function getConfiguredVisionRef(cwd: string): string | undefined {
	for (const path of settingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const ref = readVisionRef(JSON.parse(readFileSync(path, "utf8")));
			if (ref) return ref;
		} catch {
			// ignore malformed settings, try the next candidate
		}
	}
	return undefined;
}

function splitRef(ref: string): { provider: string; modelId: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** All image-capable models the registry knows about (from models.json/settings). */
function imageModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.modelRegistry.getAvailable().filter((m) => m.input.includes("image"));
}

/**
 * Pick the vision model: configured ref if valid & image-capable, else the
 * first image-capable model the registry reports. Throws with a helpful
 * message when no vision model is available at all.
 */
function resolveVisionModel(ctx: ExtensionContext): Model<Api> {
	const available = imageModels(ctx);
	const configured = getConfiguredVisionRef(ctx.cwd);

	if (configured) {
		const parsed = splitRef(configured);
		if (parsed) {
			const found = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (found && found.input.includes("image")) return found;
		}
	}

	if (available.length > 0) return available[0];

	const hint = configured
		? `Configured vision model "${configured}" is not an image-capable model in the registry.`
		: "No vision model configured.";
	throw new Error(
		`${hint} No image-capable models are available. Add an image-capable model to models.json and/or set "visionModel": "provider/model-id" in settings.json.`,
	);
}

// ── Image input resolution ──────────────────────────────────────────────────

function mimeFromExt(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".bmp":
			return "image/bmp";
		default:
			return "application/octet-stream";
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Convert arbitrary image bytes to PNG using Photon so the vision model always
 * receives a broadly-supported format (webp and friends trip up some VLMs).
 * Best-effort: on any decode/encode failure the original bytes are returned so
 * the tool still works when Photon is unavailable.
 */
function toPng(bytes: Buffer, mimeType: string): { data: string; mimeType: string } {
	if (mimeType === "image/png") return { data: bytes.toString("base64"), mimeType };
	try {
		const image = photon.PhotonImage.new_from_byteslice(new Uint8Array(bytes));
		try {
			const png = Buffer.from(image.get_bytes());
			return { data: png.toString("base64"), mimeType: "image/png" };
		} finally {
			image.free();
		}
	} catch {
		return { data: bytes.toString("base64"), mimeType };
	}
}

async function resolveImage(
	cwd: string,
	rawImage: string,
	signal: AbortSignal | undefined,
): Promise<{ data: string; mimeType: string; source: "file" | "url" | "data-url" }> {
	const image = rawImage.startsWith("@") ? rawImage.slice(1) : rawImage;

	if (image.startsWith("data:image/")) {
		const match = /^data:([^;,]+);base64,(.*)$/s.exec(image);
		if (!match) throw new Error("Only base64 data:image URLs are supported.");
		const png = toPng(Buffer.from(match[2], "base64"), match[1]);
		return { ...png, source: "data-url" };
	}

	if (isHttpUrl(image)) {
		const resp = await fetch(image, { signal });
		if (!resp.ok) throw new Error(`Image download failed (${resp.status}).`);
		const bytes = Buffer.from(await resp.arrayBuffer());
		if (bytes.byteLength > MAX_IMAGE_BYTES) {
			throw new Error(`Image is ${bytes.byteLength} bytes, larger than the ${MAX_IMAGE_BYTES}-byte limit.`);
		}
		const mimeType = resp.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
		if (!mimeType.startsWith("image/")) throw new Error(`URL did not return an image (content-type: ${mimeType}).`);
		const png = toPng(bytes, mimeType);
		return { ...png, source: "url" };
	}

	const absolutePath = isAbsolute(image) ? image : resolvePath(cwd, image);
	const fileStat = await stat(absolutePath);
	if (!fileStat.isFile()) throw new Error(`Image path is not a file: ${absolutePath}`);
	if (fileStat.size > MAX_IMAGE_BYTES) {
		throw new Error(`Image is ${fileStat.size} bytes, larger than the ${MAX_IMAGE_BYTES}-byte limit.`);
	}
	const bytes = await readFile(absolutePath);
	const png = toPng(bytes, mimeFromExt(absolutePath));
	return { ...png, source: "file" };
}

// ── Tool schema ─────────────────────────────────────────────────────────────

const InspectImageParams = Type.Object({
	image: Type.String({
		description:
			"Image to inspect: a workspace-relative path, absolute path, http(s) image URL, or data:image;base64 URL. A leading @ on a path is ignored.",
	}),
	prompt: Type.String({
		description: "What the vision model should look for, extract, or answer about the image.",
	}),
});

// ── Extension ────────────────────────────────────────────────────────────────

export default function inspectImageExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "inspect_image",
		label: "Inspect Image",
		description:
			"Analyze an image using a separate vision-capable model (chosen from pi's model registry). " +
			"Use this whenever the active chat model cannot see images.",
		promptSnippet: "Analyze an image file/URL using a vision-capable model from the registry",
		promptGuidelines: [
			"Use inspect_image for any request about an image the current model cannot see.",
			"Always pass a concrete prompt describing what to inspect; never a generic default.",
			"image accepts a path, an http(s) URL, or a data:image base64 URL.",
		],
		parameters: InspectImageParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const model = resolveVisionModel(ctx);

			const image = await resolveImage(ctx.cwd, params.image, signal ?? undefined);

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);

			const message = await completeSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: params.prompt },
								{ type: "image", data: image.data, mimeType: image.mimeType },
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: signal ?? undefined },
			);

			if (message.stopReason === "error") {
				throw new Error(message.errorMessage ?? "Vision model request failed.");
			}

			const text = message.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.filter(Boolean)
				.join("\n")
				.trim();
			if (!text) throw new Error("Vision model returned no text.");

			return {
				content: [{ type: "text", text }],
				details: {
					provider: model.provider,
					model: model.id,
					source: image.source,
					prompt: params.prompt,
				},
			};
		},
	});
}

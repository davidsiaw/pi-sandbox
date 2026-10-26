/**
 * pa-cold-warning — warn before paying to re-warm a huge Claude context you walked away from.
 *
 * Anthropic prompt caches expire (5 min default, 1 h with PI_CACHE_RETENTION=long).
 * The next prompt after expiry re-writes the WHOLE context at 1.25x (or 2x) the
 * input price. On a 300k-token Opus session that is ~$2 for one "ok continue".
 *
 * When an interactive prompt arrives and the last cache touch is older than the
 * TTL, ask: restore the full context (showing the estimated cost), or cancel and
 * keep the text in the editor (e.g. to /compact or /new first).
 *
 * Applies only to Claude models (id or provider mentions claude/anthropic).
 *
 * Env:
 *   PA_COLD_WARNING=off              disable entirely
 *   PA_COLD_WARNING_MIN_TOKENS=40000 below this, restoring is cheap; do nothing
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TTL_S = 300; // Anthropic's default ephemeral cache lifetime
const MIN_WARN_COST = 0.1; // dollars; cheaper restores aren't worth a dialog

function isClaude(model: any): boolean {
  if (!model) return false;
  return /claude|anthropic/i.test(`${model.provider ?? ""} ${model.id ?? ""}`);
}

function ttlSeconds(model: any): number {
  const tier = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
  return model?.promptCache?.[tier] ?? (tier === "long" ? 3600 : DEFAULT_TTL_S);
}

function minTokens(): number {
  const n = Number(process.env.PA_COLD_WARNING_MIN_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 40_000;
}

function ts(entry: any): number {
  const t = Date.parse(entry?.timestamp ?? "");
  return Number.isFinite(t) ? t : 0;
}

/** Last moment we know the provider cache was read or written for this branch. */
function lastCacheTouch(branch: any[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "message" && e.message?.role === "assistant") return ts(e);
    if (e.type === "usage") return ts(e); // pi's own cache_warm pings
  }
  return 0;
}

function promptTokens(branch: any[]): number {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
      const u = e.message.usage;
      return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
    }
    if (e.type === "compaction") return 0; // unknown until the next response
  }
  return 0;
}

function dollars(tokens: number, perMillion: number): string {
  return `$${((tokens * perMillion) / 1e6).toFixed(2)}`;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PA_COLD_WARNING === "off") return;

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || event.streamingBehavior || !ctx.hasUI) return;
    if (!isClaude(ctx.model)) return;

    const branch = ctx.sessionManager.getBranch() as any[];
    const touched = lastCacheTouch(branch);
    const ttl = ttlSeconds(ctx.model);
    if (!touched || Date.now() - touched < ttl * 1000) return;

    const tokens = promptTokens(branch);
    if (tokens < minTokens()) return;
    const cost = ctx.model!.cost ?? ({} as any);
    const writeRate = cost.cacheWrite || cost.input || 0;
    if (writeRate > 0 && (tokens * writeRate) / 1e6 < MIN_WARN_COST) return;

    const idleMin = Math.round((Date.now() - touched) / 60000);
    const restore = `Restore full context (~${Math.round(tokens / 1000)}k tokens${writeRate ? `, ~${dollars(tokens, writeRate)}` : ""})`;
    const keep = "Cancel (keep my text in the editor)";
    const choice = await ctx.ui.select(
      `Context is cold — idle ${idleMin} min, prompt cache (${ttl / 60} min) expired.`,
      [restore, keep],
    );

    if (choice === restore) return; // pay it; normal flow
    ctx.ui.setEditorText(event.text);
    return { action: "handled" as const };
  });
}

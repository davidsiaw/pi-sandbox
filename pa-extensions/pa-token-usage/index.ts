/**
 * pa-token-usage — append every model response's usage to a daily CSV.
 *
 * WHERE THINGS LIVE
 *   Code:  pa-extensions/pa-token-usage/index.ts
 *          -> baked to /opt/pa/extensions/pa-token-usage/ (root-owned, READ-ONLY)
 *   Data:  ~/.pi/agent/extensions/pa-token-usage/token-usage/YYYY-MM-DD.csv
 *
 *   The data dir is deliberately NOT next to this file: the baked extension dir
 *   is read-only inside the container and is destroyed on exit. The `pa`
 *   launcher bind-mounts ~/.pi/agent/extensions read-write from the host, so
 *   that path persists and is shared by every concurrent container. That
 *   sharing is exactly why the writer below must be append-atomic.
 *
 *   ~/.pi/agent/extensions/pa-token-usage/ contains no index.ts, so pi's
 *   auto-discovery of subdir index.ts files skips it, and this extension loads
 *   once, from /opt/pa only. Do not add an index.ts there: the launcher would
 *   load that copy too and every request would land twice.
 *
 * CONCURRENCY
 *   One fs.appendFileSync per row. POSIX guarantees a single write() to an
 *   O_APPEND fd is atomic when it is under PIPE_BUF (4096 bytes) on a local
 *   filesystem; rows here are ~200 bytes. So N containers interleave whole
 *   rows and never corrupt or lose one. There is no read-modify-write and no
 *   lock anywhere. The header is written with flag "wx" and EEXIST ignored,
 *   which is the same race resolved the same way.
 *
 * FAILURE POLICY
 *   Metrics must never break a turn. Every fs call is wrapped; the first
 *   failure notifies once and the rest are silent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COLUMNS = [
  "ts_iso",
  "session_id",
  "kind",
  "provider",
  "model",
  "response_model",
  "stop_reason",
  "tokens_in",
  "tokens_cache_read",
  "tokens_cache_write",
  "tokens_out",
  "tokens_reasoning",
  "tokens_total",
  "cost_input",
  "cost_cache_read",
  "cost_cache_write",
  "cost_output",
  "cost_total",
  "tokens_per_cent",
  "bytes_in",
  "bytes_out",
] as const;

/**
 * Resolved locally rather than via pi's getAgentDir() on purpose. Every other
 * extension in this repo imports pi as `type`-only; a value import is an extra
 * runtime-resolution risk for no gain. ".pi" is also not a guess here -- the
 * `pa` launcher hardcodes the same literal in its bind mount
 * (-v "$PI_HOME/agent/extensions:/home/agent/.pi/agent/extensions"), so this
 * path MUST match that one to land on the host.
 */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Read per-write, not once at load, so tests can redirect it. */
function dataDir(): string {
  return join(agentDir(), "extensions", "pa-token-usage", "token-usage");
}

let warned = false;

/** Quote only when needed; double any embedded quote. RFC4180. */
function csv(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Local (not UTC) calendar day, so a day boundary matches the user's day. */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function byteLength(value: unknown): number | "" {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return "";
  }
}

/**
 * Tokens bought per cent spent. Local models and subscription-billed providers
 * report cost 0, which would make this Infinity, so it is left blank instead.
 */
function tokensPerCent(totalTokens: number, costTotal: number): string {
  if (!Number.isFinite(costTotal) || costTotal <= 0) return "";
  if (!Number.isFinite(totalTokens)) return "";
  return (totalTokens / (costTotal * 100)).toFixed(2);
}

function writeRow(row: Record<string, unknown>, notify: (m: string) => void): void {
  const dir = dataDir();
  const file = join(dir, `${localDay(new Date())}.csv`);
  try {
    mkdirSync(dir, { recursive: true });

    // Create-exclusive: whichever container wins writes the header, the losers
    // get EEXIST and skip it. Never truncates an existing file.
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, COLUMNS.join(",") + "\n");
      } finally {
        closeSync(fd);
      }
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }

    appendFileSync(file, COLUMNS.map((c) => csv(row[c])).join(",") + "\n");
  } catch (e: any) {
    if (!warned) {
      warned = true;
      notify(`pa-token-usage: cannot write ${file}: ${e?.message ?? e}`);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event, ctx) => {
    const message: any = event.message;
    if (message?.role !== "assistant") return;

    const usage = message.usage;
    if (!usage) return;

    const cost = usage.cost ?? {};

    // bytes_in is an approximation and is labelled as such in docs: pi never
    // exposes the serialized request, so this re-serializes the active context
    // (compaction applied) as the closest available stand-in. bytes_out is the
    // exact serialized assistant content.
    let bytesIn: number | "" = "";
    try {
      bytesIn = byteLength(ctx.sessionManager.buildContextEntries());
    } catch {
      bytesIn = "";
    }

    writeRow(
      {
        ts_iso: new Date(message.timestamp ?? Date.now()).toISOString(),
        session_id: ctx.sessionManager.getSessionId?.() ?? "",
        kind: "assistant",
        provider: message.provider ?? "",
        model: message.model ?? "",
        response_model: message.responseModel ?? "",
        stop_reason: message.stopReason ?? "",
        tokens_in: usage.input ?? 0,
        tokens_cache_read: usage.cacheRead ?? 0,
        tokens_cache_write: usage.cacheWrite ?? 0,
        tokens_out: usage.output ?? 0,
        tokens_reasoning: usage.reasoning ?? "",
        tokens_total: usage.totalTokens ?? 0,
        cost_input: cost.input ?? 0,
        cost_cache_read: cost.cacheRead ?? 0,
        cost_cache_write: cost.cacheWrite ?? 0,
        cost_output: cost.output ?? 0,
        cost_total: cost.total ?? 0,
        tokens_per_cent: tokensPerCent(usage.totalTokens ?? 0, cost.total ?? 0),
        bytes_in: bytesIn,
        bytes_out: byteLength(message.content),
      },
      (m) => ctx.ui.notify(m, "warn"),
    );
  });

  // Nested LLM calls made by a tool (e.g. inspect_image -> a vision model)
  // report their own Usage on the tool result. Pi counts it separately from the
  // assistant message, so it gets its own row. The provider/model of the nested
  // call is not exposed here, hence the blank columns; the tool name is
  // recorded in `kind`.
  pi.on("tool_result", async (event, ctx) => {
    const usage: any = (event as any).usage;
    if (!usage) return;
    if (!usage.totalTokens && !usage.input && !usage.output) return;

    const cost = usage.cost ?? {};

    writeRow(
      {
        ts_iso: new Date().toISOString(),
        session_id: ctx.sessionManager.getSessionId?.() ?? "",
        kind: `tool:${(event as any).toolName ?? "unknown"}`,
        provider: "",
        model: "",
        response_model: "",
        stop_reason: "",
        tokens_in: usage.input ?? 0,
        tokens_cache_read: usage.cacheRead ?? 0,
        tokens_cache_write: usage.cacheWrite ?? 0,
        tokens_out: usage.output ?? 0,
        tokens_reasoning: usage.reasoning ?? "",
        tokens_total: usage.totalTokens ?? 0,
        cost_input: cost.input ?? 0,
        cost_cache_read: cost.cacheRead ?? 0,
        cost_cache_write: cost.cacheWrite ?? 0,
        cost_output: cost.output ?? 0,
        cost_total: cost.total ?? 0,
        tokens_per_cent: tokensPerCent(usage.totalTokens ?? 0, cost.total ?? 0),
        bytes_in: "",
        bytes_out: byteLength((event as any).content),
      },
      (m) => ctx.ui.notify(m, "warn"),
    );
  });
}

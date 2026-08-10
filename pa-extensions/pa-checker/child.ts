/**
 * pa-checker/child.ts — loaded ONLY inside the spawned checker process.
 *
 * Two jobs:
 *   1. `session_context` — lets the auditor read conversation history older than
 *      the payload it was handed, so it can check an answer against something
 *      agreed twenty turns ago instead of guessing.
 *   2. A hard read-only guard. The parent already passes --tools/--exclude-tools,
 *      but flags are one typo from being wrong and this process runs
 *      unattended against the user's real project directory. This blocks at
 *      execution time, so it holds no matter how the process was invoked.
 *
 * It reads the PARENT's session file (path in PA_CHECKER_SESSION_FILE) — this
 * process runs --no-session and has no history of its own, which is deliberate:
 * a fresh context every time is what stops the auditor inheriting the reasoning
 * it is supposed to be checking.
 *
 * CAVEAT, AND WHY IT DOES NOT MATTER
 * The answer under audit may not be flushed to that file yet when the checker
 * starts. This tool is therefore for HISTORY. The thing being judged is inlined
 * in the prompt by the parent and never read from here.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Read-only built-ins, plus this file's own tool. Everything else is blocked. */
const ALLOWED = new Set(["read", "ls", "find", "grep", "session_context"]);

const MAX_TEXT_CHARS = 1500;
const DEFAULT_LIMIT = 40;

interface Entry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: any;
  summary?: string;
}

function loadBranch(): { entries: Entry[]; error?: string } {
  const file = process.env.PA_CHECKER_SESSION_FILE;
  if (!file) return { entries: [], error: "No session file was passed to this checker (PA_CHECKER_SESSION_FILE unset)." };

  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    return { entries: [], error: `Could not read session file: ${err instanceof Error ? err.message : String(err)}` };
  }

  const all: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      /* a partially written trailing line is normal while the parent is live */
    }
  }

  // Sessions are a tree; walk parentId back from the leaf so branches the user
  // abandoned via /tree or /fork are not reported as things that happened.
  const leaf = process.env.PA_CHECKER_LEAF_ID;
  if (!leaf) return { entries: all.filter((e) => e.type === "message") };

  const byId = new Map<string, Entry>();
  for (const e of all) if (e.id) byId.set(e.id, e);

  const chain: Entry[] = [];
  let cursor: string | null | undefined = leaf;
  const seen = new Set<string>();
  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const e = byId.get(cursor) as Entry;
    chain.push(e);
    cursor = e.parentId;
  }
  chain.reverse();
  return { entries: chain.filter((e) => e.type === "message") };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} more chars]`;
}

function render(entry: Entry, index: number): string {
  const m = entry.message;
  if (!m) return "";
  const head = `[${index}] ${m.role}${entry.timestamp ? ` @ ${entry.timestamp}` : ""}`;

  if (m.role === "toolResult") {
    const body = clip(textOf(m.content).replace(/\s+/g, " ").trim(), MAX_TEXT_CHARS);
    return `${head} (${m.toolName}${m.isError ? ", ERROR" : ""})\n${body}`;
  }

  const parts: string[] = [];
  const text = textOf(m.content);
  if (text.trim()) parts.push(clip(text, MAX_TEXT_CHARS));
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c?.type === "toolCall") parts.push(`-> called ${c.name} ${clip(JSON.stringify(c.arguments ?? {}), 400)}`);
  }
  return `${head}\n${parts.join("\n") || "(no text)"}`;
}

export default function (pi: ExtensionAPI) {
  // Lock 3 of 3. --tools and --exclude-tools are locks 1 and 2, in the parent.
  pi.on("tool_call", async (event) => {
    if (ALLOWED.has(event.toolName)) return;
    return {
      block: true,
      reason: `pa-checker is a read-only verification pass: "${event.toolName}" is not available. You may only read (read, ls, find, grep, session_context). Judge the answer on the evidence you can read; you are not here to fix it.`,
    };
  });

  pi.registerTool({
    name: "session_context",
    label: "Session context",
    description:
      "Read the conversation history that led up to the answer you are auditing, beyond the excerpt in your prompt. Use mode 'transcript' to page through messages in order (most useful with a negative offset, e.g. offset=-30, to read the most recent history), or mode 'search' to find where something was discussed. Read-only.",
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal("transcript"), Type.Literal("search")], {
          description: "'transcript' pages through messages; 'search' finds messages containing text. Default 'transcript'.",
        }),
      ),
      query: Type.Optional(Type.String({ description: "Text to search for (case-insensitive). Required for mode 'search'." })),
      offset: Type.Optional(
        Type.Number({ description: "Start index for 'transcript'. Negative counts back from the end (-30 = last 30). Default: the last 40 messages." }),
      ),
      limit: Type.Optional(Type.Number({ description: `Maximum messages to return. Default ${DEFAULT_LIMIT}.` })),
    }),
    async execute(_toolCallId, params: any) {
      const { entries, error } = loadBranch();
      if (error) return { content: [{ type: "text", text: error }], details: {} };
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "The session file contains no messages yet." }], details: {} };
      }

      const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_LIMIT, 200));

      if (params.mode === "search") {
        const q = String(params.query ?? "").toLowerCase();
        if (!q) return { content: [{ type: "text", text: "mode 'search' requires a query." }], details: {} };
        const hits: string[] = [];
        for (let i = 0; i < entries.length && hits.length < limit; i++) {
          const e = entries[i];
          const hay = `${textOf(e.message?.content)} ${JSON.stringify(e.message?.content ?? "")}`.toLowerCase();
          if (hay.includes(q)) hits.push(render(e, i));
        }
        const text = hits.length
          ? `${hits.length} match(es) for "${params.query}" across ${entries.length} messages:\n\n${hits.join("\n\n")}`
          : `No match for "${params.query}" in ${entries.length} messages.`;
        return { content: [{ type: "text", text }], details: { matches: hits.length, total: entries.length } };
      }

      let start = params.offset ?? Math.max(0, entries.length - DEFAULT_LIMIT);
      if (start < 0) start = Math.max(0, entries.length + start);
      start = Math.min(start, Math.max(0, entries.length - 1));
      const slice = entries.slice(start, start + limit);

      const body = slice.map((e, i) => render(e, start + i)).join("\n\n");
      const footer = `\n\n[showing ${start}..${start + slice.length - 1} of ${entries.length} messages]`;
      return { content: [{ type: "text", text: body + footer }], details: { start, count: slice.length, total: entries.length } };
    },
  });
}

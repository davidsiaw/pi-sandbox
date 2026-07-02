/**
 * pa-example — a template extension baked into the pa sandbox image.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * READ THIS FIRST (for the next agent adding a real extension)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHERE THIS LIVES
 *   Repo:      picon/pa-extensions/<name>/index.ts
 *   In image:  /opt/pa/extensions/<name>/index.ts   (COPY in the Dockerfile)
 *   Loaded by: the `pa` launcher, which adds `-e /opt/pa/extensions/<name>`
 *              for every subdirectory that contains an index.ts.
 *
 *   Do NOT bake extensions into ~/.pi/agent/extensions — `pa` mounts that path
 *   read-write from the host, so a baked copy there would be shadowed at
 *   runtime. Baked extensions must live under /opt/pa and load via `-e`.
 *
 * LAYOUT OPTIONS (this repo uses the subdirectory style)
 *   Single file:            <name>.ts
 *   Subdirectory:           <name>/index.ts  (+ helper .ts files)  <-- used here
 *   Package with deps:      <name>/package.json + src/index.ts, then `npm
 *                           install` in that dir so node_modules/ resolves.
 *                           Runtime deps must be in "dependencies" (not dev).
 *
 * THE CONTRACT
 *   An extension default-exports a factory function that receives the
 *   ExtensionAPI (`pi`). It may be sync or async. If it returns a Promise, pi
 *   awaits it before startup continues (before session_start), so use an async
 *   factory for one-time setup like fetching remote config or discovering
 *   models. Extensions load via jiti, so TypeScript works with no build step.
 *
 * WHAT YOU CAN REGISTER (see the calls below for real signatures)
 *   pi.on(event, handler)        react to lifecycle/tool events
 *   pi.registerTool(...)         add a tool the model can call
 *   pi.registerCommand(...)      add a /command for the user
 *   pi.registerShortcut(...)     add a key binding
 *   pi.registerFlag(...)         add a CLI flag
 *   pi.registerProvider(...)     add a model provider (often in async factory)
 *
 * CONTEXT (`ctx`) HELPERS COMMONLY USED
 *   ctx.ui.notify(msg, "info"|"warn"|"error")
 *   ctx.ui.confirm(title, body) -> Promise<boolean>
 *   ctx.ui.setStatus(id, text)   footer status line
 *   ctx.ui.setWidget(id, lines)  widget above the editor
 *
 * IMPORTS AVAILABLE
 *   "@earendil-works/pi-coding-agent"  types (ExtensionAPI, contexts, events)
 *   "typebox"                          Type.* schemas for tool parameters
 *   "@earendil-works/pi-ai"            AI utils (e.g. StringEnum)
 *   "@earendil-works/pi-tui"           TUI components
 *   node built-ins (node:fs, node:path, ...) and any installed npm deps
 *
 * SECURITY
 *   Extensions run with full permissions and can execute arbitrary code. Only
 *   bake extensions you trust. Inside this sandbox the blast radius is the
 *   disposable container, but the host cwd is bind-mounted read-write.
 *
 * The body below registers one trivial command so there is something concrete
 * to copy. Delete it and build your real extension, or delete this whole
 * subdirectory if you don't need a baked extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// For a tool with typed parameters you would also:
//   import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // --- Example: a user command (/pa-example) ------------------------------
  // Commands are invoked by the user by typing `/pa-example [args]`.
  pi.registerCommand("pa-example", {
    description: "Placeholder command from the baked pa-example extension",
    handler: async (args, ctx) => {
      ctx.ui.notify(
        `pa-example loaded. args: ${args || "(none)"}`,
        "info",
      );
    },
  });

  // --- Example: reacting to a lifecycle event -----------------------------
  // Uncomment to greet on session start. See the "Events" section of
  // docs/extensions.md (in the pi install) for the full event list and the
  // lifecycle diagram (project_trust, session_start, tool_call, turn_*, etc).
  //
  // pi.on("session_start", async (_event, ctx) => {
  //   ctx.ui.notify("pa-example extension is active", "info");
  // });

  // --- Example: a tool the MODEL can call ---------------------------------
  // Tools need a typebox parameter schema. Uncomment and add the typebox
  // import above to use this.
  //
  // pi.registerTool({
  //   name: "pa_greet",
  //   label: "Greet",
  //   description: "Greet someone by name",
  //   parameters: Type.Object({
  //     name: Type.String({ description: "Name to greet" }),
  //   }),
  //   async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
  //     return {
  //       content: [{ type: "text", text: `Hello, ${params.name}!` }],
  //       details: {},
  //     };
  //   },
  // });
}

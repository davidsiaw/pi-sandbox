#!/usr/bin/env node
// Apply a source patch to EVERY copy of pi that ships in the installed package.
//
// WHY THIS EXISTS
//   pi used to run from its plain TypeScript output (`dist/modes/...`), so a
//   patch aimed at one file was the whole story. From pi 0.84 the `pi` bin in
//   package.json points at `dist/bundle/cli.js` -- an esbuild bundle with its own
//   minified copy of the same code (plus a copy of pi-agent-core inlined). The
//   pretty `dist/` tree is still shipped and still imported by the SDK, but the
//   CLI no longer reads it.
//
//   Result: patches that targeted only `dist/modes/interactive/interactive-mode.js`
//   (resume command, update banner) and `node_modules/.../pi-agent-core/dist/agent.js`
//   (tool execution) still "applied" cleanly, the build stayed green, the smoke
//   test still grepped the patched string -- and the running CLI ignored all of
//   it. Symptom that surfaced it: pi again printing
//   `pi --session-dir /path/.pi-sessions --session <id>` instead of `pa --session <id>`.
//
// WHAT IT DOES
//   Reads a JSON spec on stdin, scans every `.js` under the package's `dist/` and
//   under `node_modules/@earendil-works/*/dist/`, and applies each edit wherever
//   its anchor appears -- pretty copy and minified copy alike.
//
// THE GUARD THAT MATTERS
//   `requireBundle` (default true) asserts at least one patched file lives under
//   `dist/bundle/`, i.e. the tree the `pi` bin actually loads. That is the check
//   that fails the build if upstream reshuffles bundling again, instead of
//   shipping a silently inert patch.
//
// SPEC
//   {
//     "name": "resume-command",
//     "requireBundle": true,            // optional, default true
//     "edits": [                        // one entry per logical change
//       {
//         "what": "APP_NAME anchor",
//         "variants": [                 // pretty + minified spelling of the same edit
//           { "from": "...", "to": "...", "marker": "..." },
//           { "from": "...", "to": "...", "marker": "..." }
//         ]
//       }
//     ]
//   }
//
//   Each edit must match in at least one file (across all its variants), or the
//   run fails. Every occurrence found is replaced.
//
//   `marker` is the string that exists ONLY in this variant's patched output. It is
//   how "already applied" is recognised, which makes re-runs and cached layers
//   safe. Required, must be >= 12 chars, and must be a substring of `to`.
//
//   Two traps it is there to avoid:
//
//   - Using the whole `to` text as the applied-check looks equivalent but is not:
//     a short or generic `to` occurs naturally all over `dist/`, so every file
//     reads as "already patched" and a DEAD ANCHOR REPORTS SUCCESS. Same class of
//     silent pass this script exists to prevent.
//   - Sharing one marker between two edits of the same patch: the first edit
//     writes it, the second then sees it and skips itself. So each variant's
//     marker must be distinctive to that variant, not merely to the patch.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function piDir() {
  if (process.env.PI_DIR) return process.env.PI_DIR;
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  return path.join(root, "@earendil-works", "pi-coding-agent");
}

function collectFiles(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function candidateFiles(dir) {
  const files = collectFiles(path.join(dir, "dist"), []);
  const deps = path.join(dir, "node_modules", "@earendil-works");
  if (fs.existsSync(deps)) {
    for (const dep of fs.readdirSync(deps)) {
      collectFiles(path.join(deps, dep, "dist"), files);
    }
  }
  return files;
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

const spec = JSON.parse(readStdin());
const name = spec.name ?? "unnamed";
const requireBundle = spec.requireBundle !== false;
const dir = piDir();
const files = candidateFiles(dir);

if (files.length === 0) {
  throw new Error(`${name} patch: no .js files found under ${dir}/dist`);
}

// path -> content, loaded lazily and written back once at the end.
const contents = new Map();
const dirty = new Set();
const patchedFiles = new Set();

function load(file) {
  if (!contents.has(file)) contents.set(file, fs.readFileSync(file, "utf8"));
  return contents.get(file);
}

for (const edit of spec.edits) {
  const what = edit.what ?? "edit";

  for (const variant of edit.variants) {
    if (typeof variant.marker !== "string" || variant.marker.length < 12) {
      throw new Error(
        `${name} patch: every variant of "${what}" needs a \`marker\` of at least 12 chars -- ` +
          `a string that appears ONLY in that variant's patched output.`,
      );
    }
    if (!variant.to.includes(variant.marker)) {
      throw new Error(
        `${name} patch: marker "${variant.marker}" for "${what}" is not a substring of its \`to\`, ` +
          `so applying the edit would not make the marker true.`,
      );
    }
  }

  let hits = 0;

  for (const file of files) {
    let src = load(file);

    for (const variant of edit.variants) {
      if (src.includes(variant.marker)) {
        // Already patched (previous run, or a cached layer).
        hits += 1;
        patchedFiles.add(file);
        continue;
      }
      if (!src.includes(variant.from)) continue;

      const count = src.split(variant.from).length - 1;
      src = src.split(variant.from).join(variant.to);
      contents.set(file, src);
      dirty.add(file);
      patchedFiles.add(file);
      hits += count;
    }
  }

  if (hits === 0) {
    throw new Error(
      `${name} patch: no anchor matched for "${what}" in any of ${files.length} files under ${dir}. ` +
        `Upstream changed the code this patch depends on; the patch script needs updating.`,
    );
  }
}

if (requireBundle) {
  const bundlePrefix = path.join(dir, "dist", "bundle") + path.sep;
  const inBundle = [...patchedFiles].filter((f) => f.startsWith(bundlePrefix));
  if (inBundle.length === 0) {
    throw new Error(
      `${name} patch: nothing under dist/bundle/ was patched. That is the tree the \`pi\` bin ` +
        `loads, so the patch would be inert at runtime. Anchors likely differ in the ` +
        `minified bundle -- add a minified variant.`,
    );
  }
}

for (const file of dirty) {
  fs.writeFileSync(file, contents.get(file));
}

const rel = (f) => path.relative(dir, f);
if (dirty.size === 0) {
  console.log(`${name} patch already applied (${patchedFiles.size} file(s))`);
} else {
  console.log(`${name} patch applied to ${[...dirty].map(rel).join(", ")}`);
}

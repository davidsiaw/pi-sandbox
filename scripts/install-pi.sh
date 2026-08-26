#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="${PI_VERSION:-latest}"

npm install -g --cache /tmp/npm-cache "@earendil-works/pi-coding-agent@${PI_VERSION}"
rm -rf /tmp/npm-cache

PI_DIR="${PI_DIR:-$(npm root -g)/@earendil-works/pi-coding-agent}"
export PI_DIR
PATCHER="${PATCHER:-$(dirname "$0")/pi-patch.mjs}"
[ -f "$PATCHER" ] || { echo "pi-patch.mjs not found at $PATCHER" >&2; exit 1; }

# NOTE ON ALL PATCHES BELOW
#   pi ships the SAME code twice: the pretty `dist/` tree and the esbuild bundle
#   under `dist/bundle/` that the `pi` bin actually executes (pi >= 0.84). Every
#   patch therefore lists a pretty AND a minified variant, and pi-patch.mjs fails
#   the build if nothing under dist/bundle/ matched -- otherwise a patch applies
#   cleanly to a tree nobody loads and silently does nothing. That is exactly how
#   the resume-command patch went dead when 0.84 moved the bin to the bundle.
#
#   Each variant carries a `marker`: the substring of its own `to` that proves it
#   was applied. Markers must be distinctive per VARIANT, not merely per patch --
#   two edits sharing one marker would make the second skip itself after the first
#   wrote it. See pi-patch.mjs for the full contract.

# Resume command: print `pa --session <id>`, not `pi --session-dir ... --session <id>`.
node "$PATCHER" <<'SPEC'
{
  "name": "resume-command",
  "edits": [
    {
      "what": "APP_NAME anchor",
      "variants": [
        {
          "from": "const args = [APP_NAME];",
          "to": "const args = [process.env.PI_RESUME_COMMAND || APP_NAME];",
          "marker": "PI_RESUME_COMMAND || APP_NAME"
        },
        {
          "from": "let args=[APP_NAME];",
          "to": "let args=[process.env.PI_RESUME_COMMAND||APP_NAME];",
          "marker": "PI_RESUME_COMMAND||APP_NAME"
        }
      ]
    },
    {
      "what": "session-dir guard",
      "variants": [
        {
          "from": "if (!sessionManager.usesDefaultSessionDir()) {",
          "to": "if (!process.env.PI_RESUME_COMMAND && !sessionManager.usesDefaultSessionDir()) {",
          "marker": "PI_RESUME_COMMAND && !sessionManager.usesDefaultSessionDir"
        },
        {
          "from": "return sessionManager.usesDefaultSessionDir()||args.push(\"--session-dir\"",
          "to": "return process.env.PI_RESUME_COMMAND||sessionManager.usesDefaultSessionDir()||args.push(\"--session-dir\"",
          "marker": "PI_RESUME_COMMAND||sessionManager.usesDefaultSessionDir"
        }
      ]
    }
  ]
}
SPEC

# Serialize tool calls by default.
#
# pi's agent loop already supports sequential execution -- agent-loop.js checks
# `config.toolExecution === "sequential"` -- but the coding agent never sets it
# (grep the dist: zero references), so the "parallel" default in agent.js always
# wins. There is no setting, flag, or env var to reach it.
#
# Parallel fan-out is risky here: a weaker model can emit ten tool calls at once,
# which interleaves output, multiplies rate-limit pressure, and makes a run hard
# to review or interrupt. Built-in edit/write do serialize per-file through
# withFileMutationQueue(), so this is about predictability rather than
# correctness -- but predictability is what we want by default.
#
# This makes the default configurable via PI_TOOL_EXECUTION and flips it to
# "sequential" in the image (see ENV in the Dockerfile). Set
# PI_TOOL_EXECUTION=parallel to restore upstream behaviour.
#
# The line lives in a transitive dependency (pi-agent-core), which exists both as
# a real node_modules copy (used by the SDK) and inlined into pi's bundle (used by
# the CLI). Both are patched.
node "$PATCHER" <<'SPEC'
{
  "name": "tool-execution",
  "edits": [
    {
      "what": "toolExecution default",
      "variants": [
        {
          "from": "this.toolExecution = runtimeOptions.toolExecution ?? \"parallel\";",
          "to": "this.toolExecution = runtimeOptions.toolExecution ?? (process.env.PI_TOOL_EXECUTION === \"parallel\" || process.env.PI_TOOL_EXECUTION === \"sequential\" ? process.env.PI_TOOL_EXECUTION : \"parallel\");",
          "marker": "?? (process.env.PI_TOOL_EXECUTION ==="
        },
        {
          "from": "this.toolExecution=runtimeOptions.toolExecution??\"parallel\"",
          "to": "this.toolExecution=runtimeOptions.toolExecution??(process.env.PI_TOOL_EXECUTION===\"parallel\"||process.env.PI_TOOL_EXECUTION===\"sequential\"?process.env.PI_TOOL_EXECUTION:\"parallel\")",
          "marker": "??(process.env.PI_TOOL_EXECUTION==="
        }
      ]
    }
  ]
}
SPEC

pi --version || true

rm -rf /home/agent/.npm
mkdir -p /home/agent/.npm /home/agent/.pi/agent/npm
chmod -R 0777 /home/agent/.npm /home/agent/.pi

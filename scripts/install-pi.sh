#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="${PI_VERSION:-latest}"

npm install -g --cache /tmp/npm-cache "@earendil-works/pi-coding-agent@${PI_VERSION}"
rm -rf /tmp/npm-cache

PI_DIR="$(npm root -g)/@earendil-works/pi-coding-agent"
RESUME_FILE="$PI_DIR/dist/modes/interactive/interactive-mode.js"

node - "$RESUME_FILE" <<'PATCH'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

const appName = 'const args = [APP_NAME];';
const appNamePatched = 'const args = [process.env.PI_RESUME_COMMAND || APP_NAME];';
const guard = 'if (!sessionManager.usesDefaultSessionDir()) {';
const guardPatched = 'if (!process.env.PI_RESUME_COMMAND && !sessionManager.usesDefaultSessionDir()) {';

if (src.includes(appNamePatched) && src.includes(guardPatched)) {
  console.log("resume-command patch already applied");
} else {
  if (!src.includes(appName)) throw new Error("resume patch: APP_NAME anchor not found");
  if (!src.includes(guard)) throw new Error("resume patch: session-dir guard anchor not found");
  src = src.replace(appName, appNamePatched).replace(guard, guardPatched);
  fs.writeFileSync(file, src);
  console.log("resume-command patch applied");
}
PATCH

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
# NOTE: this patches a transitive dependency's internals, so it asserts its
# anchor and fails the build loudly if upstream restructures.
AGENT_CORE_FILE="$PI_DIR/node_modules/@earendil-works/pi-agent-core/dist/agent.js"

node - "$AGENT_CORE_FILE" <<'PATCH'
const fs = require("fs");
const file = process.argv[2];
if (!fs.existsSync(file)) {
  throw new Error(`tool-execution patch: ${file} not found`);
}
let src = fs.readFileSync(file, "utf8");

const anchor = 'this.toolExecution = runtimeOptions.toolExecution ?? "parallel";';
const patched =
  'this.toolExecution = runtimeOptions.toolExecution ?? ' +
  '(process.env.PI_TOOL_EXECUTION === "parallel" || process.env.PI_TOOL_EXECUTION === "sequential" ' +
  '? process.env.PI_TOOL_EXECUTION : "parallel");';

if (src.includes(patched)) {
  console.log("tool-execution patch already applied");
} else {
  if (!src.includes(anchor)) throw new Error("tool-execution patch: anchor not found");
  const count = src.split(anchor).length - 1;
  if (count !== 1) throw new Error(`tool-execution patch: expected 1 anchor, found ${count}`);
  src = src.replace(anchor, patched);
  fs.writeFileSync(file, src);
  console.log("tool-execution patch applied");
}
PATCH

pi --version || true

rm -rf /home/agent/.npm
mkdir -p /home/agent/.npm /home/agent/.pi/agent/npm
chmod -R 0777 /home/agent/.npm /home/agent/.pi

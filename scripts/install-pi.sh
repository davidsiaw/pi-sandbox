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

let changed = false;
if (src.includes(appNamePatched) && src.includes(guardPatched)) {
  console.log("resume-command patch already applied");
} else {
  if (!src.includes(appName)) throw new Error("resume patch: APP_NAME anchor not found");
  if (!src.includes(guard)) throw new Error("resume patch: session-dir guard anchor not found");
  src = src.replace(appName, appNamePatched).replace(guard, guardPatched);
  fs.writeFileSync(file, src);
  changed = true;
  console.log("resume-command patch applied");
}
PATCH

pi --version || true

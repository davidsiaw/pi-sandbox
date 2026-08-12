#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_TAG="${IMAGE:-davidsiaw/pi-sandbox:latest}"
VOLUME="pa-smoketest-mise"
UID_TEST="${UID_TEST:-1234}"
MISE_MOUNT="/home/agent/.local/share/mise"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
note() { printf '  \033[36mNOTE\033[0m  %s\n' "$1"; }
FAILED=0

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "Image $IMAGE_TAG not found locally. Build it (sh build.sh) or pull it first."
  exit 1
fi
echo "==> Testing image $IMAGE_TAG"

docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME" >/dev/null

run() {
  docker run --rm --user "${UID_TEST}:${UID_TEST}" \
    -v "${VOLUME}:${MISE_MOUNT}" \
    "$IMAGE_TAG" bash -lc "$1" 2>&1
}

# Like run(), but DISCARDS stderr. The entrypoint writes its diagnostics there
# ("Adding agent user to /etc/passwd..."), and run()'s 2>&1 would fold them into
# stdout ahead of the real output -- which is how the version notes below ended
# up reporting the entrypoint message instead of a version.
run_clean() {
  docker run --rm --user "${UID_TEST}:${UID_TEST}" \
    -v "${VOLUME}:${MISE_MOUNT}" \
    "$IMAGE_TAG" bash -lc "$1" 2>/dev/null
}

# Like run(), but with the security flag `pa` applies BY DEFAULT. The image
# itself still carries a NOPASSWD sudoers rule -- the restriction is a property
# of the launcher, not of the image -- so this is the only way to test what an
# agent actually gets. no-new-privileges makes the kernel ignore setuid, which
# is what kills sudo; it cannot be undone from inside the container.
run_nnp() {
  docker run --rm --user "${UID_TEST}:${UID_TEST}" \
    --security-opt no-new-privileges \
    -v "${VOLUME}:${MISE_MOUNT}" \
    "$IMAGE_TAG" bash -lc "$1" 2>&1
}

# First line of a version command's stdout that looks like a version.
#
# Reads all input then picks with awk, rather than `grep -m1` or `head -1`.
# Both of those exit as soon as they match, which SIGPIPEs the producer (exit
# 141) and, under `set -o pipefail`, makes the `||` branch fire *in addition to*
# the match -- printing the version AND "(unknown)". Version output is short
# enough that it would not trigger today, but this is the same footgun that made
# the CloakBrowser checks exit 141.
version_of() {
  local out
  out="$(run_clean "$1 2>/dev/null" | awk '/[0-9]+\.[0-9]+/ { print; exit }')"
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
  else
    echo "(unknown)"
  fi
}

echo "==> Running checks as uid ${UID_TEST}"

out="$(run 'whoami; test -w "$HOME" && echo HOME_WRITABLE')"
echo "$out" | grep -q '^agent$'        && pass "arbitrary uid resolves to a user" || fail "no passwd entry for uid ${UID_TEST}"
echo "$out" | grep -q 'HOME_WRITABLE'  && pass "HOME is writable"                 || fail "HOME not writable"

run 'pi --version'         | grep -Eq '^[0-9]+\.[0-9]+' && pass "pi present"         || fail "pi missing"
run 'node --version'       | grep -q '^v'                && pass "node present"       || fail "node missing"
run 'command -v mise >/dev/null 2>&1 && echo MISE_OK' | grep -q MISE_OK && pass "mise present" || fail "mise missing"
run 'playwright --version' | grep -qi 'version'          && pass "playwright present" || fail "playwright missing"
run 'ls /opt/ms-playwright'| grep -q 'chromium'          && pass "chromium present"   || fail "chromium missing"

# fd + ripgrep must be baked on PATH so pi's tools-manager finds them via
# commandExists() and never downloads into the ephemeral ~/.pi/agent/bin.
run 'command -v rg >/dev/null 2>&1 && echo RG_OK'      | grep -q RG_OK && pass "ripgrep on PATH" || fail "ripgrep missing from PATH"
run 'command -v fdfind >/dev/null 2>&1 && echo FD_OK'  | grep -q FD_OK && pass "fd (fdfind) on PATH" || fail "fd missing from PATH"
# pdftoppm (poppler-utils) is what pa-pdf's pdf_render uses to rasterise scanned
# pages for inspect_image. Without it, scanned PDFs are unreadable.
run 'command -v pdftoppm >/dev/null 2>&1 && echo PDFTOPPM_OK' | grep -q PDFTOPPM_OK \
  && pass "pdftoppm on PATH (poppler-utils)" || fail "pdftoppm missing from PATH"
# Ask pi's own tools-manager where it resolves fd/rg: must be a system binary
# (not a path under ~/.pi/agent/bin), which is what suppresses the download.
out="$(run 'node -e '\''import("/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js").then(m=>{const fd=m.getToolPath("fd"),rg=m.getToolPath("rg");const bad=[fd,rg].some(p=>!p||p.includes(".pi/agent/bin"));process.stdout.write(bad?("BAD fd="+fd+" rg="+rg):"TOOLS_ON_PATH")})'\'' ')"
echo "$out" | grep -q TOOLS_ON_PATH && pass "pi resolves fd+rg to system binaries (no download)" || fail "pi would still download fd/rg: $out"

# Versions, informational only — not asserted (we only care the tools exist).
note "pi           $(version_of 'pi --version')"
note "node         $(version_of 'node --version')"
note "mise         $(version_of 'mise --version')"
note "playwright   $(version_of 'playwright --version')"
note "cloakbrowser $(version_of '/opt/cloakbrowser/cloakbrowser-bin --version')"

# A project-local .ruby-version for an UNINSTALLED version must still not
# trigger a build. The exact wording varies with volume state -- "command not
# found" on a fresh volume (no shims exist yet, since shims/ lives inside the
# volume) versus "Tool not installed" once shims are present -- so accept either
# and assert separately, below, that nothing was actually compiled.
out="$(run 'mkdir -p /tmp/p && cd /tmp/p && echo 3.3.5 > .ruby-version; ruby -v 2>&1 || true')"
echo "$out" | grep -qiE 'not installed|command not found' \
  && pass "no implicit auto-install on shim call" || fail "shim call auto-installed a runtime"

# Assert on the install DIRECTORY, not on `mise ls`. `mise ls ruby` also lists
# versions that are merely *requested* by config (marked missing), so grepping
# its output for the version reports an install that never happened.
#
# Check for 3.3.5 SPECIFICALLY rather than "installs/ruby is empty". The empty
# check only holds on a fresh volume; with KEEP=1, or any volume that already
# has a Ruby, it fails for a reason that has nothing to do with this test.
run 'test -d ~/.local/share/mise/installs/ruby/3.3.5 && echo INSTALLED || echo ABSENT' \
  | grep -q ABSENT \
  && pass "uninstalled .ruby-version stayed uninstalled" \
  || fail "ruby 3.3.5 was actually installed by the shim call"

# --- Ruby is ready out of the box ------------------------------------------
# Regression: agents used to hit "No version is set for shim: ruby" even when a
# Ruby was sitting in the cache volume, because `mise use -g` writes
# ~/.config/mise/config.toml, which is neither mounted nor baked and so is lost
# on every container start. The default now lives in /etc/mise/config.toml.
# Read the baked file itself. `mise config get tools.ruby` looks at the
# highest-precedence config rather than the merged view, so it returns nothing
# as soon as a ~/.config/mise/config.toml exists -- which `mise use -g node@20`
# creates further down. That made this check pass only by virtue of test order.
run 'cat /etc/mise/config.toml' | grep -qE '^ruby = "3\.4' \
  && pass "ruby 3.4 pinned as system default" || fail "no system-wide ruby default"

# The pin must come from the baked system config, with no help from HOME.
out="$(run 'ls ~/.config/mise/config.toml 2>&1 || true; mise config ls 2>&1')"
echo "$out" | grep -q '/etc/mise/config.toml' \
  && pass "default comes from baked /etc/mise/config.toml" || fail "system mise config not read"

# The bug that hid Ruby even when installed: `mise activate` strips the shims
# dir from PATH, so every process pi spawned inherited a PATH with no shims.
# Position matters as much as presence -- the shims dir has to beat /usr/bin or
# a mise-selected runtime silently loses to the system one, which is exactly how
# `mise use -g node@20` ends up reporting the system v22. Assert it is FIRST.
run 'echo "$PATH"' | grep -q '/.local/share/mise/shims' \
  && pass "mise shims on PATH in a login shell" || fail "mise shims missing from login-shell PATH"
# Assert the ORDERING, not a positional index. The original form checked that
# the shims were literally PATH entry #1, which broke the moment pa-apt added
# its own /etc/profile.d entry -- a false failure, since the property that
# matters was never "index 0" but "ahead of the things it must beat".
#
# Required precedence:  mise shims  >  pa-apt prefix  >  /usr/bin
# i.e. a project's pinned runtime beats an explicitly installed tool, which
# beats the system. Both profile.d snippets PREPEND, so this is really a test of
# their sourcing order (00-pa-apt.sh before mise.sh).
out="$(run 'p=$(echo "$PATH" | tr ":" "\n")
  s=$(echo "$p" | grep -n "mise/shims"     | head -1 | cut -d: -f1)
  a=$(echo "$p" | grep -n "pa-apt/usr/bin" | head -1 | cut -d: -f1)
  u=$(echo "$p" | grep -nx "/usr/bin"      | head -1 | cut -d: -f1)
  echo "shims=$s pa-apt=$a usr=$u"
  [ -n "$s" ] && [ -n "$a" ] && [ -n "$u" ] && [ "$s" -lt "$a" ] && [ "$a" -lt "$u" ] && echo ORDER_OK')"
echo "$out" | grep -q ORDER_OK \
  && pass "PATH precedence: mise shims > pa-apt > /usr/bin" \
  || fail "PATH precedence wrong ($(echo "$out" | grep -o 'shims=.*'))"

# A pinned default must NOT override a project's own .ruby-version. Current mise
# ignores idiomatic version files unless opted in, which would make a repo
# pinning 3.3.5 silently run the 3.4 default -- a worse failure than an error.
run 'mise settings get idiomatic_version_file_enable_tools' | grep -q 'ruby' \
  && pass ".ruby-version is honored (idiomatic version files enabled)" \
  || fail ".ruby-version ignored: project pins would be silently overridden"

# Ruby itself can only be asserted when the cache volume already holds one.
# This test runs against a FRESH volume, and the shims directory lives *inside*
# that volume ($MISE_DATA_DIR/shims) -- so on a fresh volume there is no `ruby`
# shim to call and the honest result is "command not found". Only the config is
# baked into the image; the runtime is not. Assert the config resolves, and
# report the install state rather than failing on it.
run 'mise current ruby 2>/dev/null | tail -1' | grep -q '^3\.4' \
  && pass "system default resolves to a 3.4.x" \
  || fail "system default does not resolve to 3.4.x"

out="$(run 'cd /tmp && ruby -v 2>&1 || true')"
if echo "$out" | grep -q 'ruby 3\.4'; then
  pass "ruby 3.4 runs from the cache volume"
else
  note "ruby not built in this fresh volume (expected): one 'mise install ruby' populates it"
fi

run 'mise use -g node@20 >/dev/null 2>&1; node --version' | grep -q '^v20\.' \
  && pass "mise installs node@20 on demand (explicit)" || fail "mise explicit install failed"

out="$(run 'which pi; pi --version')"
echo "$out" | grep -q '^/usr/bin/pi$' && pass "pi resolves to system node" || fail "pi not on system node"
echo "$out" | grep -Eq '^[0-9]+\.[0-9]+' && pass "pi still runs after node switch" || fail "pi broke after node switch"

run 'mise ls node' | grep -q '20\.' && pass "cache volume persists node@20" || fail "cache volume did not persist runtime"

# The IMAGE keeps sudo: `pa --sudo` works by simply not passing the security
# flag, so the sudoers rule must still be there.
run 'sudo -n true 2>&1 && echo SUDO_OK' | grep -q SUDO_OK \
  && pass "passwordless sudo works (pa --sudo path)" || fail "passwordless sudo failed"

# ...but the DEFAULT launcher flag must deny it, at the kernel level.
out="$(run_nnp 'sudo -n true 2>&1 || true')"
echo "$out" | grep -qi 'no new privileges' \
  && pass "sudo denied under no-new-privileges (pa default)" \
  || fail "sudo NOT denied under no-new-privileges: $out"

# The whole point of denying sudo is that installing a tool must still work.
# Uses a package with a dependency (jq needs libjq1 + libonig5) so this also
# covers apt's dependency resolution against the image's real dpkg status, and
# asserts the profile.d PATH wiring works with no manual activation.
out="$(run_nnp 'pa-apt install jq >/dev/null 2>&1; jq --version 2>&1')"
echo "$out" | grep -q '^jq-' \
  && pass "pa-apt installs a package with deps without sudo" \
  || fail "pa-apt failed without sudo: $out"

# A package already in the image must be a no-op, not an error.
run_nnp 'pa-apt install ripgrep 2>&1' | grep -qi 'already satisfied' \
  && pass "pa-apt no-ops on an already-installed package" \
  || fail "pa-apt did not detect an already-satisfied package"

# /etc/passwd must be world-writable (arbitrary uid appends its own line at
# startup); /etc/shadow must NOT be. The shadow entry carries no uid, so it is
# baked at build time and the file stays root-only. These two run together
# because sudo breaks if the shadow ENTRY is missing -- the check above would
# catch that -- and the whole point is keeping the entry while dropping write
# access to the file.
# Tested as the property that matters, from the unprivileged uid, rather than by
# pattern-matching an octal mode string.
run 'test -w /etc/passwd && echo PASSWD_WRITABLE' | grep -q PASSWD_WRITABLE \
  && pass "/etc/passwd is writable (arbitrary uid can add itself)" || fail "/etc/passwd not writable"
run 'test -w /etc/shadow && echo SHADOW_WRITABLE || echo SHADOW_PROTECTED' | grep -q SHADOW_PROTECTED \
  && pass "/etc/shadow is NOT writable by the container user" || fail "/etc/shadow is world-writable"
run 'sudo -n grep -c "^agent:" /etc/shadow' | grep -q '^1$' \
  && pass "/etc/shadow has the agent entry (sudo PAM needs it)" || fail "/etc/shadow missing agent entry"

ver="$(run 'cat /usr/lib/node_modules/@earendil-works/pi-coding-agent/package.json' | grep -oE '"version": *"[^"]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
run 'cat "$HOME/.pi/agent/settings.json"' | grep -q "\"lastChangelogVersion\": \"${ver}\"" \
  && pass "settings seeded with current version (no changelog)" || fail "settings not seeded with pi version"

# trust.json must be writable AND pre-trust the project cwd (so pi never
# prompts or hits EROFS writing it). Run the entrypoint's seed against a chosen
# workdir and assert that resolved path is trusted true.
out="$(docker run --rm --user "${UID_TEST}:${UID_TEST}" -w /tmp \
  "$IMAGE_TAG" bash -lc '
    /usr/local/bin/seed-trust.sh
    test -w "$HOME/.pi/agent/trust.json" && echo TRUST_WRITABLE
    node -e "const t=require(process.env.HOME+\"/.pi/agent/trust.json\"); const fs=require(\"fs\"); const k=fs.realpathSync(\"/tmp\"); process.stdout.write(t[k]===true?\"CWD_TRUSTED\":\"NOT_TRUSTED\")"
  ' 2>&1)"
echo "$out" | grep -q TRUST_WRITABLE && echo "$out" | grep -q CWD_TRUSTED \
  && pass "trust.json seeded writable + pre-trusts project cwd" || fail "trust seed wrong: $out"

run 'touch "$HOME/.npm/wtest" "$HOME/.pi/agent/npm/wtest" 2>&1 && echo NPM_WRITABLE' | grep -q NPM_WRITABLE \
  && pass "npm dirs writable (pi can install extensions)" || fail "npm dirs not writable for arbitrary uid"

run 'echo "$PI_RESUME_COMMAND"' | grep -q '^pa$' \
  && pass "PI_RESUME_COMMAND=pa in image" || fail "PI_RESUME_COMMAND not set to pa"
run 'grep -q "process.env.PI_RESUME_COMMAND || APP_NAME" /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js && echo PATCHED' | grep -q PATCHED \
  && pass "resume-command patch applied to pi" || fail "resume-command patch missing"

# pi's "Update Available" banner must say `pa update`. Following `pi update` in
# here upgrades a container that is destroyed on exit, so the banner returns next
# launch; pulling the image is what updating pi means.
run 'echo "$PA_UPDATE_COMMAND"' | grep -q '^pa update$' \
  && pass "PA_UPDATE_COMMAND='pa update' in image" || fail "PA_UPDATE_COMMAND not set to 'pa update'"
run 'grep -q "process.env.PA_UPDATE_COMMAND" /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js && echo PATCHED' | grep -q PATCHED \
  && pass "update-command patch applied to pi" || fail "update-command patch missing"

# The sibling extensions banner is deliberately NOT redirected: pi packages live
# under ~/.pi/agent/npm and `pa update` would not touch them, so `pi update
# --extensions` remains the best advice available.
run 'grep -q "APP_NAME} update --extensions" /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js && echo INTACT' | grep -q INTACT \
  && pass "extensions-update banner left alone" || fail "extensions banner was rewritten or moved"

# Tool calls must be serialized. pi's agent loop supports it but the coding agent
# never sets toolExecution, so install-pi.sh patches agent.js to read
# PI_TOOL_EXECUTION and the image sets it to "sequential".
run 'echo "$PI_TOOL_EXECUTION"' | grep -q '^sequential$' \
  && pass "PI_TOOL_EXECUTION=sequential in image" || fail "PI_TOOL_EXECUTION not set to sequential"
run 'grep -q "process.env.PI_TOOL_EXECUTION" /usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js && echo PATCHED' | grep -q PATCHED \
  && pass "tool-execution patch applied to pi-agent-core" || fail "tool-execution patch missing"

# Assert the patch actually changes the resolved strategy, not just that the
# string is present: construct the Agent and read back toolExecution for each
# env value. Guards against a future upstream refactor that keeps the text but
# ignores it.
# Written to a file inside the container rather than passed inline: `&&` and
# backticks do not survive the nested single-quoting of run() + bash -lc, and
# fail silently when they break. A stub streamFn is required because the Agent
# constructor throws without one; no model call is made.
out="$(run 'cat > /tmp/toolexec.mjs <<"EOF"
import { Agent } from "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js";
const stub = async () => { throw new Error("unused"); };
const modeFor = (v) => {
  if (v === undefined) delete process.env.PI_TOOL_EXECUTION; else process.env.PI_TOOL_EXECUTION = v;
  return new Agent({ streamFn: stub }).toolExecution;
};
const seq = modeFor("sequential");
const par = modeFor("parallel");
const unset = modeFor(undefined);
const junk = modeFor("lolwut");
const ok = seq === "sequential" && par === "parallel" && unset === "parallel" && junk === "parallel";
process.stdout.write(ok ? "TOOLEXEC_OK" : "BAD seq=" + seq + " par=" + par + " unset=" + unset + " junk=" + junk);
EOF
node /tmp/toolexec.mjs 2>&1')"
echo "$out" | grep -q TOOLEXEC_OK \
  && pass "PI_TOOL_EXECUTION selects strategy (seq/parallel/unset/invalid)" \
  || fail "tool-execution patch does not affect resolved strategy: $out"

run 'test -s /opt/pa/APPEND_SYSTEM.base.md && echo BASE_OK' | grep -q BASE_OK \
  && pass "baked APPEND_SYSTEM.base.md present" || fail "baked base guidance missing"

run 'ls /opt/pa/skills/*/SKILL.md 2>/dev/null' | grep -q SKILL.md \
  && pass "baked skill present" || fail "baked skill missing"
run 'ls /opt/pa/extensions/*/index.ts 2>/dev/null' | grep -q index.ts \
  && pass "baked extension present" || fail "baked extension missing"

out="$(run 'pi -e /opt/pa/extensions/pa-example -p hi 2>&1 | head -20')"
if echo "$out" | grep -qi 'Failed to load extension'; then
  fail "baked extension fails to load"
else
  pass "baked extension loads (no load error)"
fi

# pa-rag's upstream loader must survive being run THROUGH JITI, which is how pi
# loads extensions -- not through plain node, which is how the selftests run.
#
# That gap shipped a fully broken pa-rag: an `await import()` added inside
# upstream.ts's load() was hoisted by jiti's ESM->CJS transform above the `const
# jitiImport` it depends on, so every call threw "Cannot access 'jitiImport'
# before initialization" -- killing rag_search and all indexing. Plain-node ESM
# handles that shape fine, so ~90 selftest checks stayed green while the extension
# was dead in the real container.
#
# Scoped to pa-rag on purpose. A bare jiti import is NOT a valid check for every
# extension: several (pa-anthropic-oauth, pa-inspect-image) import pi's own
# packages (@earendil-works/pi-tui, pi-ai/compat), which only resolve inside pi's
# module context -- they fail under standalone jiti while working perfectly under
# `pi -e`, which the pa-example check above already covers. upstream.ts imports
# only node builtins plus its own siblings, so it CAN be loaded standalone, and it
# is where the hoisting hazard lives.
#
# Importing is not sufficient (the bug was inside a function), so this CALLS
# load(). A missing-dependency error is fine; a TDZ/hoisting error is not.
# run_clean, not run: the entrypoint's "Adding agent user..." goes to stderr and
# 2>&1 would fold it into the result string -- which is exactly how the first
# version of this check reported a bogus failure.
out="$(run_clean 'cat > /tmp/jitiload.mjs <<"JEOF"
import { join } from "node:path";
const JITI = "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti";
const { createJiti } = await import(JITI + "/lib/jiti.mjs");
const dir = "/opt/pa/extensions/pa-rag";
const jiti = createJiti("file://" + dir + "/", { interopDefault: true });
let verdict = "JITI_LOAD_OK";
try {
  const up = await jiti.import(join(dir, "upstream.ts"));
  await up.load(dir);
} catch (err) {
  const msg = String(err && err.message);
  if (/before initialization|is not defined|Cannot access/.test(msg)) {
    verdict = "JITI_LOAD_FAIL " + msg.slice(0, 140);
  }
}
process.stdout.write(verdict);
JEOF
node /tmp/jitiload.mjs 2>/dev/null')"
if echo "$out" | grep -q JITI_LOAD_OK; then
  pass "pa-rag upstream loader runs under jiti (pi's real loader)"
else
  fail "pa-rag broken under jiti: $(echo "$out" | sed 's/^.*JITI_LOAD_FAIL //')"
fi

# yousoro-browse behavioral guard: fingerprint init script + block/challenge
# detection (visible-text, not raw HTML — the 403-then-redirect fix) + markdown
# rendering + the automatic escalation to CloakBrowser on a block. Auth-free,
# runs a real Chromium via the baked selftest.
out="$(run 'cd /opt/pa/extensions/pa-yousoro-browse && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "yousoro-browse selftest (fingerprint + detection + markdown + escalation)"
else
  fail "yousoro-browse selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# The shared stealth module must be baked but must NOT look like an extension:
# it has no index.ts, which is exactly what makes the pa launcher's loader loop
# skip it. Pointing `pi -e` at a directory without an index.ts is a FATAL pi
# startup error, so a stray index.ts here would break every container.
run 'test -f /opt/pa/extensions/_shared/stealth.ts && echo SHARED_OK' | grep -q SHARED_OK \
  && pass "_shared/stealth.ts baked" || fail "_shared/stealth.ts missing"
run 'test -e /opt/pa/extensions/_shared/index.ts && echo HAS_INDEX || echo NO_INDEX' | grep -q NO_INDEX \
  && pass "_shared has no index.ts (launcher skips it)" || fail "_shared/index.ts exists; pa would load it as an extension and abort"

# pa-screenshot guard: output-path policy (.png only, traversal rejected,
# inside/outside the project classified — that decides whether the file survives
# the container), refuse-to-overwrite, and a real capture asserting JS ran first.
out="$(run 'cd /opt/pa/extensions/pa-screenshot && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-screenshot selftest (path policy + JS-rendered capture)"
else
  fail "pa-screenshot selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# pa-console guard: the REPL rests on live-page properties that break silently
# and cannot be caught by reading code -- injected output being distinguishable
# from the page's own, window state surviving between evals while a top-level
# const does not, and above all a DELAYED error still being captured after the
# call that triggered it returned. That last one failing would make the tool
# report "no errors" for a page that is still broken.
out="$(run 'cd /opt/pa/extensions/pa-console && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-console selftest (REPL state + late-error capture + formatting)"
else
  fail "pa-console selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# The pa-console tools deliberately carry only a pointer in their descriptions;
# the usage guidance lives in the skill, which is loaded on demand. If the skill
# stops being baked, the tools keep working but every hint about how to use them
# is gone -- a silent quality loss with no error anywhere.
run 'test -s /opt/pa/skills/pa-console/SKILL.md && echo CONSOLE_SKILL_OK' | grep -q CONSOLE_SKILL_OK \
  && pass "pa-console skill baked (tools point at it for usage)" \
  || fail "pa-console skill missing; page_console has no usage guidance"
# Count INSIDE the container and emit a token, rather than comparing $out as an
# integer out here: run() folds stderr into stdout, so the entrypoint's "Adding
# agent user to /etc/passwd..." arrives ahead of the number and `[ -ge ]` dies
# with "integer expression expected".
run 'n=$(grep -c page_console /opt/pa/skills/pa-console/SKILL.md 2>/dev/null || echo 0); [ "$n" -ge 5 ] && echo CONSOLE_SKILL_DOCS_OK' | grep -q CONSOLE_SKILL_DOCS_OK \
  && pass "pa-console skill documents the tools" \
  || fail "pa-console skill does not mention page_console enough to be useful"

# pa-anthropic-oauth guard: /resume used to kill pi with "This extension ctx is
# stale after session replacement or reload" — the usage poller's 60s interval
# was started from session_start with no session_shutdown handler, so it
# outlived its session and the next tick hit the throwing `ctx.ui` getter from a
# timer callback (uncaughtException, nothing to catch it). Drives three sessions
# through the real module and asserts no uncaught throw plus no timer/listener
# pile-up. Auth-free: no token, no network.
out="$(run 'cd /opt/pa/extensions/pa-anthropic-oauth && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-anthropic-oauth selftest (survives session replacement)"
else
  fail "pa-anthropic-oauth selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# pa-checker guard: the verification pass. The safety property comes first --
# the audit runs unattended against the user's real project directory, so the
# checker subprocess must be unable to write, edit or run a command no matter
# how it was invoked. The rest is about not making things worse than no checker
# at all: a model with no "checker" key must never spawn anything, the revision
# loop must terminate in a shipped answer rather than billing forever, and every
# failure (dead model, garbage verdict, timeout) must fail OPEN. Drives the real
# spawn path against a fake `pi` on PATH. Auth-free: no model, no network.
out="$(run 'cd /opt/pa/extensions/pa-checker && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-checker selftest (read-only checker + bounded loop + fail-open)"
else
  fail "pa-checker selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# pa-pdf guard: the map -> search -> read loop. pdf_map must report a PDF's
# shape without returning body text (a 300-page document is ~29k tokens -- the
# failure mode is drowning the model, not hanging it); pdf_search must map match
# offsets back to the right page and stay literal by default; pdf_read must stay
# bounded and hand back a cursor that round-trips. Pages with no text layer must
# be reported rather than silently returned empty.
# Also guards the BORROW: pdf-parse comes from pa-rag's node_modules, so a
# pa-rag dependency change breaks pa-pdf at a distance.
out="$(run 'cd /opt/pa/extensions/pa-pdf && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-pdf selftest (offsets + windowing + search + render)"
else
  fail "pa-pdf selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# pa-token-usage guard: CSV row/header agreement, cost-0 handling (local models
# and subscription billing report 0, which must not become Infinity), and the
# multi-writer append race. That race is real, not hypothetical: every container
# bind-mounts the SAME host ~/.pi/agent/extensions, so N agents append to one
# file concurrently. The selftest spawns 8 writers x 40 rows and asserts nothing
# is lost, torn, or double-headered.
out="$(run 'cd /opt/pa/extensions/pa-token-usage && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-token-usage selftest (csv schema + concurrent append)"
else
  fail "pa-token-usage selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# The data dir must NOT be baked next to the code. /opt/pa is read-only and
# ephemeral; the CSVs have to land in the host-mounted ~/.pi/agent/extensions.
# A token-usage/ dir baked here would mean the extension silently writes into
# the container and every row is lost on exit.
run 'test -e /opt/pa/extensions/pa-token-usage/token-usage && echo HAS_DATA || echo NO_DATA' | grep -q NO_DATA \
  && pass "pa-token-usage ships no baked data dir (CSVs go to the host mount)" \
  || fail "pa-token-usage/token-usage is baked into the image; rows would be lost on exit"

# The uitag model must be baked, exactly like the pa-rag one. This is the check
# that was missing when detect_ui_elements shipped registered-but-modelless: the
# selftest below SKIPs without a model, so on its own it stays green while the
# published image quietly lacks the tool.
run 'test -f /opt/pa/models/uitag/yolo-ui.onnx && echo UITAG_MODEL_BAKED' | grep -q UITAG_MODEL_BAKED \
  && pass "pa-uitag model baked into image" || fail "pa-uitag model missing from /opt/pa/models/uitag"

# photon must be pa-uitag's OWN dependency. It used to be borrowed from pa-rag,
# where it exists only transitively via pi-local-rag -- so an upstream patch bump
# could have dropped it and silently killed detect_ui_elements. onnxruntime-node
# is still borrowed on purpose (31 MB); photon is 2.2 MB and not worth the risk.
run 'test -d /opt/pa/extensions/pa-uitag/node_modules/@silvia-odwyer/photon-node && echo PHOTON_OWNED' \
  | grep -q PHOTON_OWNED \
  && pass "pa-uitag owns its photon dep (not borrowed from pa-rag)" || fail "pa-uitag photon dep missing"

# pa-uitag guard: box geometry (in-bounds, positive area, integer coords) and
# the contract that matters -- cropping by a reported box yields exactly that
# size, since the tool exists to hand agents crop coordinates. SKIPs when the
# model was not baked (PA_UITAG_MODEL_URL unset at build time), so a build
# without the model is not a red test.
out="$(run 'cd /opt/pa/extensions/pa-uitag && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-uitag selftest (box geometry + crop contract)"
elif echo "$out" | grep -q 'selftest: SKIP'; then
  note "pa-uitag selftest skipped (model not baked; set PA_UITAG_MODEL_URL to bake it)"
else
  fail "pa-uitag selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# CloakBrowser smoke test: verify binary exists, is executable, and can run --version
out="$(run 'test -x /opt/cloakbrowser/cloakbrowser-bin && echo CLOAKBROWSER_OK' 2>&1)"
if echo "$out" | grep -q 'CLOAKBROWSER_OK'; then
  pass "CloakBrowser binary present and executable"
else
  fail "CloakBrowser binary missing or not executable"
fi

# Which release actually got baked. The Chromium version alone cannot tell a
# free build from a Pro one, and a Pro binary baked without a licence fails at
# RUNTIME -- long after the build looked fine. install-cloakbrowser.sh records
# the resolved tag for exactly this check.
out="$(run 'cat /opt/cloakbrowser/RELEASE_TAG 2>/dev/null || echo NO_TAG')"
if echo "$out" | grep -q 'NO_TAG'; then
  fail "CloakBrowser RELEASE_TAG missing (install-cloakbrowser.sh should write it)"
elif echo "$out" | grep -qi -- '-pro'; then
  fail "CloakBrowser baked a Pro release without a licence: $(echo "$out" | tr -d '\r\n')"
else
  pass "CloakBrowser is a free release ($(echo "$out" | tr -d '\r\n'))"
fi

# Verify CloakBrowser can actually start and report version (non-interactive check).
# Avoid `head -1`: it closes the pipe after reading one line, causing
# CloakBrowser child processes to get SIGPIPE (exit 141) with pipefail.
out="$(run '/opt/cloakbrowser/cloakbrowser-bin --version 2>&1 || echo CLOAKBROWSER_FAIL')"
if echo "$out" | grep -qiE 'CloakBrowser|Chromium|version'; then
  pass "CloakBrowser --version works"
else
  fail "CloakBrowser failed to run (--version): $out"
fi

# CloakBrowser functional test: actually fetch a simple page to verify rendering works
# We use http://example.com which is lightweight and always available.
# grep -c returns 0 when count>0 (match found) or 1 (no match), avoiding
# SIGPIPE from grep exiting before the upstream finishes streaming.
out="$(run 'timeout 45 /opt/cloakbrowser/cloakbrowser-bin --headless --no-sandbox --dump-dom http://example.com 2>&1 | grep -ci "<h1>Example Domain</h1>" && echo PAGE_FETCH_OK' 2>&1)"
if echo "$out" | grep -q 'PAGE_FETCH_OK'; then
  pass "CloakBrowser successfully fetched and rendered a page"
else
  fail "CloakBrowser failed to fetch/render example.com: $out"
fi

# pa-cloakbrowser output guard: --dump-dom returns hundreds of KB of markup, and
# the tool used to return ALL of it inline, which could swallow a conversation.
# Asserts the preview is bounded, the complete output is cached to a file whose
# tail survives, and the html->text path keeps line structure (a single giant
# line makes the cache file ungreppable).
out="$(run 'cd /opt/pa/extensions/pa-cloakbrowser && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-cloakbrowser selftest (markdown + two cache files + block detection)"
else
  fail "pa-cloakbrowser selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# pa-rag: the walker must include dotfiles / dot-dirs / past pi sessions while
# excluding .git, node_modules and its own store, and the upstream loader must
# still reach pi-local-rag's submodules through jiti. PA_RAG_SKIP_EMBED skips
# the ONNX inference phase: it is far too slow under QEMU emulation in CI, and
# the structural checks are what actually regress.
out="$(run 'cd /opt/pa/extensions/pa-rag && PA_RAG_SKIP_EMBED=1 node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-rag selftest (walker + upstream loader + slicer)"
else
  fail "pa-rag selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# pa-rag must never hand upstream the whole file list. indexFiles() holds every
# chunk and vector in memory until one commit at the end, so peak memory is
# O(repo): a big repo OOM-kills the container regardless of batch size. The
# extension slices into SLICE_BYTES groups, which also makes each slice a commit
# checkpoint that an interrupted pass resumes from by hash.
run 'grep -q "indexSliced" /opt/pa/extensions/pa-rag/index.ts && echo SLICED' | grep -q SLICED \
  && pass "pa-rag indexes in slices (memory is O(slice), not O(repo))" \
  || fail "pa-rag lost its sliced indexing; large repos will OOM"
run 'grep -qE "await upstream\.indexFiles\(files" /opt/pa/extensions/pa-rag/index.ts && echo UNSLICED || echo OK_NO_WHOLE_LIST' \
  | grep -q OK_NO_WHOLE_LIST \
  && pass "pa-rag never passes the whole file list to upstream" \
  || fail "pa-rag calls indexFiles() with the entire walk result"

# The 23MB embedding model must be baked, not downloaded at runtime: a cold
# container has no reason to hit the network, and QEMU builds must not stall.
run 'test -d /opt/pa/models/Xenova/all-MiniLM-L6-v2 && echo MODEL_BAKED' | grep -q MODEL_BAKED \
  && pass "pa-rag embedding model baked into image" || fail "pa-rag model missing from /opt/pa/models"

# The batch-size patch must be applied. Upstream's hardcoded BATCH_SIZE=64 peaks
# at ~2.2GB RSS for one batch of real (~3300-char) source chunks, which OOM-kills
# the container inside Docker Desktop's ~3.8GB VM -- exit 137, schema-only index
# DB, and a TUI killed mid-render leaving the terminal in raw mode.
run 'grep -q "PA_RAG_BATCH_SIZE" /opt/pa/extensions/pa-rag/node_modules/pi-local-rag/embed.ts && echo BATCH_PATCHED' \
  | grep -q BATCH_PATCHED \
  && pass "pa-rag embed batch-size patch applied" || fail "pa-rag embed.ts not patched (indexing will OOM)"
run 'grep -q "max_length: 512" /opt/pa/extensions/pa-rag/node_modules/pi-local-rag/embed.ts && echo TRUNC_PATCHED' \
  | grep -q TRUNC_PATCHED \
  && pass "pa-rag embed truncates at the model's 512-token limit" || fail "pa-rag embed.ts missing truncation"

# Assert the patch RESOLVES to a safe default, not merely that the text is there.
out="$(run 'cd /opt/pa/extensions/pa-rag && node -e '\''import("/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs").then(async(j)=>{const P="/opt/pa/extensions/pa-rag/node_modules/pi-local-rag";const jiti=j.createJiti("file://"+P+"/",{interopDefault:true});const m=await jiti.import(P+"/embed.ts");process.stdout.write(m.BATCH_SIZE===8?"BATCH_8":"BAD "+m.BATCH_SIZE)})'\'' ')"
echo "$out" | grep -q BATCH_8 \
  && pass "pa-rag BATCH_SIZE resolves to 8" || fail "pa-rag BATCH_SIZE wrong: $out"

# The batch size must be resolved PER CALL, not frozen at module load. pa-rag
# lowers it to 2 for unattended background passes (~314MB peak vs ~800MB at 8)
# and restores 8 for an explicit /rag-index. If resolveBatchSize() ever goes back
# to being read once at import time, the low-memory background mode silently
# stops working and big repos get memory-hungry again.
out="$(run 'cd /opt/pa/extensions/pa-rag && node -e '\''import("/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs").then(async(j)=>{const P="/opt/pa/extensions/pa-rag/node_modules/pi-local-rag";const jiti=j.createJiti("file://"+P+"/",{interopDefault:true});const m=await jiti.import(P+"/embed.ts");if(typeof m.resolveBatchSize!=="function"){process.stdout.write("NO_RESOLVER");return;}process.env.PA_RAG_BATCH_SIZE="2";const lo=m.resolveBatchSize();process.env.PA_RAG_BATCH_SIZE="8";const hi=m.resolveBatchSize();delete process.env.PA_RAG_BATCH_SIZE;const def=m.resolveBatchSize();process.stdout.write(lo===2&&hi===8&&def===8?"PERCALL_OK":"BAD lo="+lo+" hi="+hi+" def="+def)})'\'' ')"
echo "$out" | grep -q PERCALL_OK \
  && pass "pa-rag batch size is resolved per call (background can go low-memory)" \
  || fail "pa-rag batch size not per-call: $out"

# The extension must actually USE the two modes, and must not record throughput
# from a throttled background pass (its elapsed time is mostly deliberate sleep,
# so measuring it would poison every future ETA).
run 'grep -q "BACKGROUND_BATCH_SIZE" /opt/pa/extensions/pa-rag/index.ts && grep -q "BACKGROUND_DUTY_CYCLE" /opt/pa/extensions/pa-rag/index.ts && echo MODES' \
  | grep -q MODES \
  && pass "pa-rag has low-memory + duty-cycled background mode" \
  || fail "pa-rag lost its background resource limits"
run 'grep -q "!opts.background && result.chunks > 200" /opt/pa/extensions/pa-rag/index.ts && echo GUARDED' \
  | grep -q GUARDED \
  && pass "pa-rag does not calibrate throughput from throttled passes" \
  || fail "pa-rag would record throttled background time as throughput"

# A pass that can run for hours needs live progress, and it must be a footer
# status (one mutable line) rather than notifications (permanent transcript
# spam). Guarded by ctx.hasUI so print/JSON runs stay clean, and cleared on
# shutdown so a resumed session does not inherit a frozen bar.
run 'grep -q "setStatus" /opt/pa/extensions/pa-rag/index.ts && echo STATUS' | grep -q STATUS \
  && pass "pa-rag reports progress via footer status" \
  || fail "pa-rag has no live progress reporting"
run 'grep -q "ctx.hasUI ? makeStatus(ctx) : undefined" /opt/pa/extensions/pa-rag/index.ts && echo GUARD' | grep -q GUARD \
  && pass "pa-rag progress is guarded by ctx.hasUI (no print-mode noise)" \
  || fail "pa-rag progress not guarded for non-UI modes"
run 'grep -q "onChunkProgress" /opt/pa/extensions/pa-rag/index.ts && echo FINE' | grep -q FINE \
  && pass "pa-rag progress updates within a slice, not just at boundaries" \
  || fail "pa-rag progress only updates per slice (coarse on big repos)"
# The denominator must self-correct: BYTES_PER_CHUNK is a guess that measured
# 1854 vs 3324 on two real trees, so a fixed denominator renders >100%.
run 'grep -q "Math.max(estTotalChunks, doneChunks)" /opt/pa/extensions/pa-rag/index.ts && echo CLAMPED' \
  | grep -q CLAMPED \
  && pass "pa-rag progress denominator self-corrects (never exceeds 100%)" \
  || fail "pa-rag progress can render over 100%"

# Retrieval-quality fixes, driven by feedback from an agent working a large
# codebase that chose rg over rag_search. Each of these is a measured symptom, so
# each gets a guard.

# Session transcripts must be excluded by default: one scored 1.000 on the exact
# identifier `partial_capture_amount_cents` and outranked every real hit, with
# content that was an unrelated regex dump.
run 'grep -q "SESSION_DIRS" /opt/pa/extensions/pa-rag/walk.ts && echo SESSIONS_GATED' \
  | grep -q SESSIONS_GATED \
  && pass "pa-rag gates session transcripts behind an opt-in" \
  || fail "pa-rag still indexes .pi-sessions unconditionally"
out="$(run 'cd /opt/pa/extensions/pa-rag && node -e '\''import("/opt/pa/extensions/pa-rag/walk.ts").then(m=>{const s=m.SKIP_DIRS;process.stdout.write(s.has(".pi-sessions")?"EXCLUDED":"INCLUDED")})'\'' ')"
echo "$out" | grep -q EXCLUDED \
  && pass "pa-rag excludes .pi-sessions from the default walk" \
  || fail "pa-rag default walk still includes sessions: $out"

# When sessions ARE opted in, they must be indexed as parsed prose. Embedding raw
# JSONL (one line can be a whole assistant turn) is what made them poison search.
run 'grep -q "__paRagExtractJsonl" /opt/pa/extensions/pa-rag/node_modules/pi-local-rag/chunking.ts && echo JSONL_PATCHED' \
  | grep -q JSONL_PATCHED \
  && pass "pa-rag .jsonl extraction patch applied to upstream" \
  || fail "pa-rag jsonl patch missing (sessions would embed as raw JSON)"
out="$(run 'cd /opt/pa/extensions/pa-rag && node -e '\''import("/opt/pa/extensions/pa-rag/walk.ts").then(m=>{const t=m.extractSessionText(JSON.stringify({type:"message",message:{role:"user",content:"hello world"}}));process.stdout.write(t==="user: hello world"?"PARSER_OK":"BAD:"+t)})'\'' ')"
echo "$out" | grep -q PARSER_OK \
  && pass "pa-rag session parser emits role-labelled prose" \
  || fail "pa-rag session parser wrong: $out"

# Excerpts must not end mid-token. The old renderer did content.slice(0, 1200),
# producing tails like "params = par" and "class_" that cost a follow-up read.
run 'grep -q "truncateAtLine" /opt/pa/extensions/pa-rag/index.ts && echo LINE_SAFE' | grep -q LINE_SAFE \
  && pass "pa-rag truncates excerpts on line boundaries" \
  || fail "pa-rag still truncates excerpts mid-token"
# Strip comment lines before checking: the docstring explaining this very fix
# quotes the old `content.slice(0, 1200)`, which made the first version of this
# check fail on its own documentation.
run 'grep -vE "^[[:space:]]*(//|\*|/\*)" /opt/pa/extensions/pa-rag/index.ts | grep -qE "content\.slice\(0, *1200\)" && echo RAW_SLICE || echo NO_RAW_SLICE' \
  | grep -q NO_RAW_SLICE \
  && pass "pa-rag has no blind character slice left (outside comments)" \
  || fail "pa-rag still contains the mid-token slice"

# Path scoping was the single most-requested control ("the #1 reason I reach for
# rg"), and it only works if the candidate set is over-fetched first: hybridSearch
# truncates to topK internally, so filtering a limit-sized list starves results.
run 'grep -q "path_include" /opt/pa/extensions/pa-rag/index.ts && grep -q "path_exclude" /opt/pa/extensions/pa-rag/index.ts && echo GLOBS' \
  | grep -q GLOBS \
  && pass "pa-rag exposes path_include / path_exclude" \
  || fail "pa-rag has no path filters"
run 'grep -q "CANDIDATE_MULTIPLIER" /opt/pa/extensions/pa-rag/index.ts && echo OVERFETCH' | grep -q OVERFETCH \
  && pass "pa-rag over-fetches before filtering (filters do not starve results)" \
  || fail "pa-rag filters a limit-sized list; path filters would return too few hits"

# Same-file chunks used to eat the result budget (limit=8 returning 3 chunks of
# one file); collapse to one entry per file.
run 'grep -q "more chunk(s) in this file" /opt/pa/extensions/pa-rag/index.ts && echo COLLAPSED' | grep -q COLLAPSED \
  && pass "pa-rag collapses chunks per file (limit means distinct files)" \
  || fail "pa-rag returns duplicate chunks from one file"

# Freshness: without it an agent cannot calibrate trust and greps anyway.
run 'grep -q "describeFreshness" /opt/pa/extensions/pa-rag/index.ts && echo FRESH' | grep -q FRESH \
  && pass "pa-rag reports index freshness in results" \
  || fail "pa-rag results carry no freshness signal"

# The impl/test bias must be strong enough to fix the REPORTED case: a spec at
# 0.600 outranking the right answer at 0.463. 0.8 was tried and still lost
# (0.480 > 0.463), so anything above 0.772 means the knob exists but does nothing.
out="$(run 'grep -E "^const TEST_DOWNWEIGHT" /opt/pa/extensions/pa-rag/index.ts')"
weight="$(echo "$out" | grep -oE '0\.[0-9]+')"
if [ -n "$weight" ] && awk "BEGIN{exit !($weight < 0.772)}"; then
  pass "pa-rag test down-weight ($weight) actually reorders the reported case"
else
  fail "pa-rag test down-weight too mild to fix spec-over-impl: $out"
fi

# Changing WHAT is indexed cannot be detected by upstream's per-file content
# hashes, so an existing store would keep serving session chunks forever.
run 'grep -q "INDEX_VERSION" /opt/pa/extensions/pa-rag/index.ts && echo VERSIONED' | grep -q VERSIONED \
  && pass "pa-rag versions the store so policy changes force a rebuild" \
  || fail "pa-rag cannot invalidate a store built under an older policy"

# The probe cap must not sit below the auto-index budget, or every project
# between the two limits wrongly falls into the "ask first" path.
#
# Evaluated as arithmetic rather than parsed as a number: the two constants are
# written with different unit chains (`1024 * 1024 * 1024` vs `2 * 1024 * ...`),
# so comparing leading integers compares GB against MB. This check's first
# version did exactly that and reported a false failure.
out="$(run 'node -e '\''const fs=require("fs");const s=fs.readFileSync("/opt/pa/extensions/pa-rag/index.ts","utf8");const g=(n)=>{const m=s.match(new RegExp("const "+n+" = ([0-9*ate ]+);"));return m?Function("return ("+m[1]+")")():NaN;};const a=g("AUTO_INDEX_MAX_BYTES"),p=g("PROBE_CAP_BYTES");process.stdout.write(Number.isFinite(a)&&Number.isFinite(p)&&p>=a?("CAPS_OK auto="+(a/1048576)+"MB probe="+(p/1048576)+"MB"):("BAD auto="+a+" probe="+p))'\'' ')"
if echo "$out" | grep -q CAPS_OK; then
  pass "pa-rag probe cap >= auto-index budget ($(echo "$out" | grep -oE 'auto=[0-9]+MB probe=[0-9]+MB'))"
else
  fail "pa-rag probe cap below auto-index budget: $out"
fi

# END-TO-END MEMORY GUARD. This is the check whose absence let the OOM ship: the
# pa-rag selftest runs with PA_RAG_SKIP_EMBED=1 in CI and its fixture chunks are
# tiny, so neither exercised a realistic batch. Embed 64 chunks at ~3300 chars
# (the real p100 chunk size measured on this repo) and assert the process
# SURVIVES -- an OOM kill here shows up as exit 137 rather than a failed check.
out="$(run 'cd /opt/pa/extensions/pa-rag && cat > /tmp/memguard.mjs <<"MEOF"
process.env.TRANSFORMERS_CACHE = "/opt/pa/models";
process.env.HF_HOME = "/opt/pa/models";
const P = "/opt/pa/extensions/pa-rag/node_modules";
const { env, pipeline } = await import(P + "/@xenova/transformers/src/transformers.js");
env.cacheDir = "/opt/pa/models";
env.allowRemoteModels = false;
const { createJiti } = await import("/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs");
const jiti = createJiti("file://" + P + "/pi-local-rag/", { interopDefault: true });
const embed = await jiti.import(P + "/pi-local-rag/embed.ts");
const texts = Array.from({ length: 64 }, () => "word ".repeat(660));
const vectors = await embed.embedBatch(texts);
const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
const ok = vectors.length === 64 && vectors[0].length === 384 && rss < 1500;
process.stdout.write(ok ? "MEMGUARD_OK rss=" + rss : "BAD n=" + vectors.length + " dim=" + (vectors[0]||[]).length + " rss=" + rss);
MEOF
node /tmp/memguard.mjs 2>&1')"
if echo "$out" | grep -q MEMGUARD_OK; then
  pass "pa-rag embeds 64 real-sized chunks without OOM ($(echo "$out" | grep -oE 'rss=[0-9]+'))"
else
  fail "pa-rag embedding OOMs or misbehaves at realistic chunk size: $out"
fi

out="$(run 'diff -q /opt/pa/APPEND_SYSTEM.base.md "$HOME/.pi/agent/APPEND_SYSTEM.md" >/dev/null 2>&1 && echo SAME')"
echo "$out" | grep -q SAME \
  && pass "no host append -> target equals baked base" || fail "target != base when no host append"

out="$(docker run --rm --user "${UID_TEST}:${UID_TEST}" \
  -v "${VOLUME}:${MISE_MOUNT}" \
  -v "$(pwd)/pa-context/APPEND_SYSTEM.base.md:/opt/pa/APPEND_SYSTEM.host.md:ro" \
  "$IMAGE_TAG" bash -lc '
    t="$HOME/.pi/agent/APPEND_SYSTEM.md"
    head -1 "$t" | grep -q "沙盒之境" && echo HOST_FIRST
    grep -c "沙盒之境" "$t"
  ' 2>&1)"
echo "$out" | grep -q HOST_FIRST && pass "host append is merged first" || fail "host append not merged first"
echo "$out" | grep -q '^2$' && pass "host + base both present in merge" || fail "merge did not include both parts"

echo
if [ "$FAILED" = "0" ]; then
  printf '\033[32mAll smoke tests passed.\033[0m\n'
else
  printf '\033[31mSmoke tests FAILED.\033[0m\n'
  exit 1
fi

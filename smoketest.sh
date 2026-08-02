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

out="$(run 'mkdir -p /tmp/p && cd /tmp/p && echo 3.3.5 > .ruby-version; ruby -v 2>&1 || true')"
echo "$out" | grep -qi 'command not found' \
  && pass "no implicit auto-install on shim call" || fail "shim call auto-installed a runtime"

run 'mise use -g node@20 >/dev/null 2>&1; node --version' | grep -q '^v20\.' \
  && pass "mise installs node@20 on demand (explicit)" || fail "mise explicit install failed"

out="$(run 'which pi; pi --version')"
echo "$out" | grep -q '^/usr/bin/pi$' && pass "pi resolves to system node" || fail "pi not on system node"
echo "$out" | grep -Eq '^[0-9]+\.[0-9]+' && pass "pi still runs after node switch" || fail "pi broke after node switch"

run 'mise ls node' | grep -q '20\.' && pass "cache volume persists node@20" || fail "cache volume did not persist runtime"

run 'sudo -n true 2>&1 && echo SUDO_OK' | grep -q SUDO_OK \
  && pass "passwordless sudo works" || fail "passwordless sudo failed"

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

# yousoro-browse behavioral guard: fingerprint init script + block/challenge
# detection (visible-text, not raw HTML — the 403-then-redirect fix). Auth-free,
# runs a real Chromium via the baked selftest.
out="$(run 'cd /opt/pa/extensions/pa-yousoro-browse && node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "yousoro-browse selftest (fingerprint + detection)"
else
  fail "yousoro-browse selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# CloakBrowser smoke test: verify binary exists, is executable, and can run --version
out="$(run 'test -x /opt/cloakbrowser/cloakbrowser-bin && echo CLOAKBROWSER_OK' 2>&1)"
if echo "$out" | grep -q 'CLOAKBROWSER_OK'; then
  pass "CloakBrowser binary present and executable"
else
  fail "CloakBrowser binary missing or not executable"
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

# pa-rag: the walker must include dotfiles / dot-dirs / past pi sessions while
# excluding .git, node_modules and its own store, and the upstream loader must
# still reach pi-local-rag's submodules through jiti. PA_RAG_SKIP_EMBED skips
# the ONNX inference phase: it is far too slow under QEMU emulation in CI, and
# the structural checks are what actually regress.
out="$(run 'cd /opt/pa/extensions/pa-rag && PA_RAG_SKIP_EMBED=1 node selftest.mjs 2>&1')"
if echo "$out" | grep -q 'selftest: all checks passed'; then
  pass "pa-rag selftest (walker + upstream loader)"
else
  fail "pa-rag selftest failed"
  echo "$out" | grep -i 'FAIL' | sed 's/^/      /'
fi

# The 23MB embedding model must be baked, not downloaded at runtime: a cold
# container has no reason to hit the network, and QEMU builds must not stall.
run 'test -d /opt/pa/models/Xenova/all-MiniLM-L6-v2 && echo MODEL_BAKED' | grep -q MODEL_BAKED \
  && pass "pa-rag embedding model baked into image" || fail "pa-rag model missing from /opt/pa/models"

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

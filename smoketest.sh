#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_TAG="${IMAGE:-davidsiaw/pi-sandbox:latest}"
VOLUME="pa-smoketest-mise"
UID_TEST="${UID_TEST:-1234}"
MISE_MOUNT="/home/agent/.local/share/mise"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
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

echo "==> Running checks as uid ${UID_TEST}"

out="$(run 'whoami; test -w "$HOME" && echo HOME_WRITABLE')"
echo "$out" | grep -q '^agent$'        && pass "arbitrary uid resolves to a user" || fail "no passwd entry for uid ${UID_TEST}"
echo "$out" | grep -q 'HOME_WRITABLE'  && pass "HOME is writable"                 || fail "HOME not writable"

run 'pi --version'         | grep -Eq '^[0-9]+\.[0-9]+' && pass "pi present"         || fail "pi missing"
run 'node --version'       | grep -q '^v'                && pass "node present"       || fail "node missing"
run 'mise --version'       | grep -Eq '[0-9]{4}\.'       && pass "mise present"       || fail "mise missing"
run 'playwright --version' | grep -qi 'version'          && pass "playwright present" || fail "playwright missing"
run 'ls /opt/ms-playwright'| grep -q 'chromium'          && pass "chromium present"   || fail "chromium missing"

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

run 'touch "$HOME/.npm/wtest" "$HOME/.pi/agent/npm/wtest" 2>&1 && echo NPM_WRITABLE' | grep -q NPM_WRITABLE \
  && pass "npm dirs writable (pi can install extensions)" || fail "npm dirs not writable for arbitrary uid"

run 'echo "$PI_RESUME_COMMAND"' | grep -q '^pa$' \
  && pass "PI_RESUME_COMMAND=pa in image" || fail "PI_RESUME_COMMAND not set to pa"
run 'grep -q "process.env.PI_RESUME_COMMAND || APP_NAME" /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js && echo PATCHED' | grep -q PATCHED \
  && pass "resume-command patch applied to pi" || fail "resume-command patch missing"

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

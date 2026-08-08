#!/usr/bin/env bash
set -euo pipefail

# Install CloakBrowser. By default it picks the newest FREE release; set
# CLOAKBROWSER_VERSION to pin an exact tag (e.g. chromium-v146.0.7680.177.4 --
# check the tag has assets for every arch you build, or that leg fails).
#
# ---------------------------------------------------------------------------
# ONE API REQUEST, AND WHY THE ARCHES CAN DIFFER
#
# Auto-detection picks the newest non-Pro release that actually carries a binary
# for the CURRENT architecture. That last part is not pedantry: CloakHQ ships
# arm64 only on some point releases (in the free 146 line, .5 is x64-only while
# .4/.3/.2 include arm64), so the two legs of a multi-arch build can legitimately
# resolve to different tags. Each image records what it got in RELEASE_TAG.
#
# WHY THIS MAKES EXACTLY ONE API CALL
#
# The previous version fetched the release list and then re-fetched EVERY tag
# individually to look at its assets -- about 21 calls per build, doubled to ~42
# by a multi-arch build, against GitHub's unauthenticated limit of 60/hour/IP.
# Two builds in an hour exhausted the quota on their own.
#
# When that happened the API returned {"message":"API rate limit exceeded..."},
# which parsed to zero tags, and the script reported:
#
#     ERROR: Could not find a free CloakBrowser release for linux-x64
#     The latest releases appear to be Pro-only.
#
# That is a misdiagnosis of a rate limit, and it sends you looking at CloakHQ's
# release policy instead of at your API budget. Both problems are fixed here:
# the list response already embeds each release's assets, so one call is enough,
# and a rate-limit response is now detected and reported as itself.
#
# Parsing is done with node (installed earlier in the Dockerfile by
# install-node-system.sh) rather than grep/sed, because picking an asset out of
# nested JSON with line-oriented tools is how the fragility started.
# ---------------------------------------------------------------------------

CLOAKBROWSER_DIR="/opt/cloakbrowser"
BINARY_NAME="cloakbrowser-bin"
REPO="CloakHQ/CloakBrowser"

echo "Installing CloakBrowser to ${CLOAKBROWSER_DIR}..."

mkdir -p "${CLOAKBROWSER_DIR}"
cd "${CLOAKBROWSER_DIR}"

ARCH="$(uname -m)"
if [ "$ARCH" = "x86_64" ]; then
  PLATFORM="linux-x64"
elif [ "$ARCH" = "aarch64" ]; then
  PLATFORM="linux-arm64"
else
  echo "Unsupported architecture: ${ARCH}"
  exit 1
fi

echo "Architecture: ${ARCH} (${PLATFORM})"

PINNED_VERSION="${CLOAKBROWSER_VERSION:-}"

# The Dockerfile pins a tag by default, and build.sh only forwards a NON-empty
# CLOAKBROWSER_VERSION -- so there would otherwise be no way to ask for
# auto-detection from the command line. "auto" is that escape hatch.
if [ "${PINNED_VERSION}" = "auto" ] || [ "${PINNED_VERSION}" = "latest-free" ]; then
  PINNED_VERSION=""
fi

# An authenticated request gets 5000/hour instead of 60. CI usually has a token
# already; nothing here requires one.
CURL_AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  CURL_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  echo "Using GITHUB_TOKEN for GitHub API requests (higher rate limit)."
fi

if [ -n "${PINNED_VERSION}" ]; then
  echo "Using pinned CloakBrowser version: ${PINNED_VERSION}"
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${PINNED_VERSION}"
else
  echo "Checking GitHub releases for the newest free build for ${PLATFORM}..."
  # per_page=100 is GitHub's maximum and costs the same ONE request as any
  # smaller page. Coverage matters because arm64 is published irregularly: the
  # newest release carrying a linux-arm64 asset can sit well down the list
  # behind Pro-only releases and x64-only point releases.
  API_URL="https://api.github.com/repos/${REPO}/releases?per_page=100"
fi

RESPONSE="$(curl -sSL "${CURL_AUTH[@]}" -H "Accept: application/vnd.github+json" "${API_URL}")"

# Select "<tag>\t<url>" for our platform, or print a diagnosis and exit non-zero.
SELECTED="$(printf '%s' "${RESPONSE}" | node -e '
const platform = process.argv[1];
const pinned = process.argv[2];
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Could not parse the GitHub API response as JSON:");
    console.error(raw.slice(0, 300));
    process.exit(1);
  }

  // A rate limit (or any other API error) is an object with a message, not an
  // array of releases. Report it as itself instead of as "no free release".
  if (!Array.isArray(data)) {
    if (data && typeof data.message === "string") {
      const msg = data.message;
      if (/rate limit/i.test(msg)) {
        console.error("GitHub API rate limit exceeded.");
        console.error("");
        console.error("This is NOT a CloakBrowser licensing problem. Unauthenticated");
        console.error("requests are limited to 60/hour per IP. Either wait for the reset,");
        console.error("set GITHUB_TOKEN, or pin CLOAKBROWSER_VERSION (which needs 1 call).");
        console.error("Check remaining quota: curl -s https://api.github.com/rate_limit");
        process.exit(1);
      }
      if (/^Not Found$/i.test(msg) && pinned) {
        console.error(`No CloakBrowser release tagged "${pinned}".`);
        console.error(`Tags look like: chromium-v146.0.7680.177.5`);
        console.error(`Browse them: https://github.com/${"CloakHQ/CloakBrowser"}/releases`);
        process.exit(1);
      }
      console.error(`GitHub API error: ${msg}`);
      process.exit(1);
    }
    // A single release object (the pinned path) is valid; wrap it.
    data = [data];
  }

  const isPro = (tag) => /-pro$/i.test(tag) || /\bpro\b/i.test(tag);
  const assetFor = (rel) =>
    (rel.assets || []).find(
      (a) => typeof a.name === "string" &&
        a.name.includes(platform) &&
        /\.(tar\.gz|zip)$/.test(a.name),
    );

  for (const rel of data) {
    const tag = rel && rel.tag_name;
    if (!tag) continue;
    // Only skip Pro when auto-detecting: an explicit pin is the caller saying
    // they know what they want (e.g. they hold a licence).
    if (!pinned && isPro(tag)) continue;
    if (rel.draft) continue;
    const asset = assetFor(rel);
    if (asset) {
      process.stdout.write(`${tag}\t${asset.browser_download_url}`);
      return;
    }
  }

  console.error(`No CloakBrowser build for ${platform} in the releases checked.`);
  console.error("Tags seen: " + data.map((r) => r && r.tag_name).filter(Boolean).join(", "));
  process.exit(1);
});
' "${PLATFORM}" "${PINNED_VERSION}")"

RELEASE_TAG="${SELECTED%%$'\t'*}"
DOWNLOAD_URL="${SELECTED#*$'\t'}"

if [ -z "${RELEASE_TAG}" ] || [ -z "${DOWNLOAD_URL}" ]; then
  echo "ERROR: could not resolve a CloakBrowser download URL"
  exit 1
fi

echo "Using release: ${RELEASE_TAG}"
echo "Downloading: ${DOWNLOAD_URL}"

TARBALL="$(basename "${DOWNLOAD_URL}")"
if ! curl -fsSL "${DOWNLOAD_URL}" -o "${TARBALL}"; then
  echo "Failed to download CloakBrowser from ${DOWNLOAD_URL}"
  exit 1
fi

if [[ "${TARBALL}" == *.tar.gz ]]; then
  tar xzf "${TARBALL}"
  rm -f "${TARBALL}"
elif [[ "${TARBALL}" == *.zip ]]; then
  unzip -q "${TARBALL}"
  rm -f "${TARBALL}"
else
  echo "Unsupported archive format: ${TARBALL}"
  exit 1
fi

# Find and rename the binary
if [ -f "cloakbrowser" ]; then
  mv "cloakbrowser" "${BINARY_NAME}"
elif [ -f "chromium" ]; then
  mv "chromium" "${BINARY_NAME}"
elif [ -f "CloakBrowser" ]; then
  mv "CloakBrowser" "${BINARY_NAME}"
else
  EXE=$(find . -maxdepth 1 -type f -executable \( -name "*cloakbrowser*" -o -name "*chromium*" -o -name "chrome" \) | head -1 || true)
  if [ -n "$EXE" ]; then
    mv "$EXE" "${BINARY_NAME}"
  else
    echo "Could not find CloakBrowser binary in extracted files"
    ls -la
    exit 1
  fi
fi

chmod +x "${BINARY_NAME}"

# Record which release this image actually shipped. Without it the only clue is
# the Chromium version, which does not distinguish a free build from a Pro one
# -- and a Pro binary baked without a licence fails at RUNTIME, long after the
# build looked fine. The smoke test asserts this is not a -pro tag.
printf '%s\n' "${RELEASE_TAG}" > "${CLOAKBROWSER_DIR}/RELEASE_TAG"

echo "Verifying installation..."
if "./${BINARY_NAME}" --version 2>/dev/null || "./${BINARY_NAME}" --help 2>&1 | head -1; then
  :
fi

echo ""
echo "=== CloakBrowser Installation Complete ==="
echo "Binary:  ${CLOAKBROWSER_DIR}/${BINARY_NAME}"
ls -lh "${CLOAKBROWSER_DIR}/${BINARY_NAME}"
echo "Release: ${RELEASE_TAG}"
echo ""
echo "Note: free builds trail the Pro line. For Pro builds and reCAPTCHA v3 0.9"
echo "score, set CLOAKBROWSER_LICENSE_KEY to download Pro binaries at runtime."

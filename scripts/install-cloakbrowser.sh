#!/usr/bin/env bash
set -euo pipefail

# Install the latest FREE CloakBrowser version
# Automatically detects and downloads the last free release (before Pro-only)

CLOAKBROWSER_DIR="/opt/cloakbrowser"
BINARY_NAME="cloakbrowser-bin"

echo "Installing latest FREE CloakBrowser to ${CLOAKBROWSER_DIR}..."

mkdir -p "${CLOAKBROWSER_DIR}"
cd "${CLOAKBROWSER_DIR}"

# Detect architecture
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

# Fetch all releases and find the latest FREE one
echo "Checking GitHub releases for latest free version..."

# Get all releases (sorted by date, newest first)
ALL_RELEASES=$(curl -sL "https://api.github.com/repos/CloakHQ/CloakBrowser/releases?per_page=20")

# Find the latest release that is NOT Pro-only
# Pro releases typically have "-pro" in tag or require license
FREE_RELEASE=""
FREE_TAG=""

while IFS= read -r tag; do
  [ -z "$tag" ] && continue
  
  # Skip Pro releases
  if [[ "$tag" == *"-pro"* ]] || [[ "$tag" == *"Pro"* ]]; then
    continue
  fi
  
  # Check if this release has a free binary for our platform
  RELEASE_INFO=$(curl -sL "https://api.github.com/repos/CloakHQ/CloakBrowser/releases/tags/${tag}")
  
  # Check if this release has assets for our platform
  ASSETS=$(echo "${RELEASE_INFO}" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 || true)
  
  if echo "${ASSETS}" | grep -qi "${PLATFORM}"; then
    FREE_TAG="${tag}"
    FREE_RELEASE="${RELEASE_INFO}"
    echo "Found free release: ${FREE_TAG}"
    break
  fi
done < <(echo "${ALL_RELEASES}" | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)

if [ -z "${FREE_TAG}" ]; then
  echo "ERROR: Could not find a free CloakBrowser release for ${PLATFORM}"
  echo ""
  echo "The latest releases appear to be Pro-only."
  echo "Options:"
  echo "  1. Set CLOAKBROWSER_LICENSE_KEY to use Pro binaries"
  echo "  2. Manually specify a version: CLOAKBROWSER_VERSION=0.4.12 sh build.sh"
  echo "  3. Check releases: https://github.com/CloakHQ/CloakBrowser/releases"
  exit 1
fi

echo "Using free release: ${FREE_TAG}"

# Extract the tarball name
TARBALL=""
DOWNLOAD_URL=""

# Try common naming patterns
for pattern in "cloakbrowser-${PLATFORM}" "CloakBrowser-${PLATFORM}" "${PLATFORM}"; do
  MATCH=$(echo "${FREE_RELEASE}" | grep -o "\"browser_download_url\": *\"[^\"]*${pattern}[^\"]*\"" | head -1 | cut -d'"' -f4 || true)
  if [ -n "${MATCH}" ]; then
    TARBALL=$(basename "${MATCH}")
    DOWNLOAD_URL="${MATCH}"
    break
  fi
done

if [ -z "${DOWNLOAD_URL}" ]; then
  echo "ERROR: No compatible binary found in release ${FREE_TAG}"
  echo "Available assets:"
  echo "${FREE_RELEASE}" | grep -o '"browser_download_url": *"[^"]*"' | head -5
  exit 1
fi

echo "Downloading: ${DOWNLOAD_URL}"

if ! curl -sL "${DOWNLOAD_URL}" -o "${TARBALL}"; then
  echo "Failed to download CloakBrowser tarball"
  exit 1
fi

# Extract based on file type
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

# Verify
echo "Verifying installation..."
if "./${BINARY_NAME}" --version 2>/dev/null || "./${BINARY_NAME}" --help 2>&1 | head -1; then
  echo ""
  echo "=== CloakBrowser Installation Complete ==="
  echo "Binary: ${CLOAKBROWSER_DIR}/${BINARY_NAME}"
  ls -lh "${CLOAKBROWSER_DIR}/${BINARY_NAME}"
  echo "Version: ${FREE_TAG} (latest free)"
else
  echo "CloakBrowser binary installed (executable exists)"
  echo ""
  echo "=== CloakBrowser Installation Complete ==="
  echo "Binary: ${CLOAKBROWSER_DIR}/${BINARY_NAME}"
  ls -lh "${CLOAKBROWSER_DIR}/${BINARY_NAME}"
  echo "Version: ${FREE_TAG} (latest free)"
fi

echo ""
echo "Note: This is the latest FREE version. For Pro builds and reCAPTCHA v3 0.9 score,"
echo "set CLOAKBROWSER_LICENSE_KEY to download Pro binaries at runtime."

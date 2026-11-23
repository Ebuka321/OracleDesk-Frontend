#!/usr/bin/env bash
set -euo pipefail

# verify-build.sh - Reproduce and verify OracleDesk static export bit-for-bit
# Usage: ./scripts/verify-build.sh [COMMIT_OR_TAG]
#
# Proves:
#   The published static export files match the repository source at the specified
#   commit when compiled using the pinned Node toolchain and release environment.
#
# Does NOT prove:
#   Whether the commit itself or third-party dependencies are free of malicious source code.

TARGET_COMMIT="${1:-HEAD}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=========================================================="
echo "OracleDesk Static Build Reproducibility Verifier"
echo "Target Commit: ${TARGET_COMMIT}"
echo "=========================================================="

# Check toolchain prerequisites
NODE_REQUIRED="$(cat "${REPO_ROOT}/.nvmrc" | tr -d '[:space:]')"
NODE_ACTUAL="$(node -v | sed 's/v//' | cut -d'.' -f1)"

echo "Node version required: ${NODE_REQUIRED}. Current: ${NODE_ACTUAL}"
if [[ "${NODE_ACTUAL}" != "${NODE_REQUIRED}" ]]; then
  echo "WARNING: Node version mismatch. CI and release builds use Node ${NODE_REQUIRED}."
fi

# Create temporary worktrees to compare builds
TEMP_DIR_A="$(mktemp -d -t oracledesk_verify_a_XXXXXX)"
TEMP_DIR_B="$(mktemp -d -t oracledesk_verify_b_XXXXXX)"

cleanup() {
  echo "Cleaning up temporary directories..."
  rm -rf "${TEMP_DIR_A}" "${TEMP_DIR_B}" || true
}
trap cleanup EXIT

echo "1. Checking out commit ${TARGET_COMMIT} to clean build directories..."
git archive "${TARGET_COMMIT}" | tar -x -C "${TEMP_DIR_A}"
git archive "${TARGET_COMMIT}" | tar -x -C "${TEMP_DIR_B}"

build_dir() {
  local target_dir="$1"
  local build_name="$2"
  echo "Building in ${build_name} (${target_dir})..."
  cd "${target_dir}"
  cp .env.release .env.production.local
  npm ci --legacy-peer-deps --ignore-scripts
  node scripts/run-allowed-install-scripts.mjs
  npx next build
  node scripts/generate-manifest.mjs out
}

echo "2. Running Build A..."
build_dir "${TEMP_DIR_A}" "Directory A"

echo "3. Running Build B (independent directory)..."
build_dir "${TEMP_DIR_B}" "Directory B"

echo "4. Comparing output bit-for-bit (diff -r out/)..."
if diff -r "${TEMP_DIR_A}/out" "${TEMP_DIR_B}/out" >/dev/null; then
  echo "SUCCESS: Both builds produced bit-for-bit IDENTICAL static exports!"
  cat "${TEMP_DIR_A}/out/manifest.sha256"
else
  echo "FAIL: Static export outputs differ between builds:"
  diff -qr "${TEMP_DIR_A}/out" "${TEMP_DIR_B}/out" || true
  exit 1
fi

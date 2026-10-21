#!/bin/bash
set -euo pipefail
SOURCE_ROOT="$(cd "$(dirname "$0")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mediashare-tests.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
python3 "$SOURCE_ROOT/Tests/make_fixtures.py" "$TEST_ROOT/fixtures"
xcrun swiftc -swift-version 5 -O "$SOURCE_ROOT/Sources/UpdatePolicy.swift" "$SOURCE_ROOT/Tests/UpdatePolicyTests.swift" -o "$TEST_ROOT/update-policy-tests"
PACKAGE_PATH="${1:-$SOURCE_ROOT/../build/macos/MediaShare-macOS.zip}"
if [[ ! -f "$PACKAGE_PATH" && -f "$SOURCE_ROOT/../artifact/MediaShare-macOS.zip" ]]; then
  PACKAGE_PATH="$SOURCE_ROOT/../artifact/MediaShare-macOS.zip"
fi
if [[ -f "$PACKAGE_PATH" ]]; then
  "$TEST_ROOT/update-policy-tests" "$TEST_ROOT/fixtures" "$PACKAGE_PATH"
else
  "$TEST_ROOT/update-policy-tests" "$TEST_ROOT/fixtures"
fi
APP_PATH="$(dirname "$PACKAGE_PATH")/MediaShare.app"
if [[ -d "$APP_PATH" ]]; then
  xcrun swiftc -swift-version 5 -O -framework Cocoa -framework CryptoKit \
    "$SOURCE_ROOT/Sources/UpdatePolicy.swift" "$SOURCE_ROOT/Sources/Updater.swift" \
    "$SOURCE_ROOT/Tests/UpdaterIntegrityTests.swift" -o "$TEST_ROOT/update-integrity-tests"
  "$TEST_ROOT/update-integrity-tests" "$APP_PATH"
fi

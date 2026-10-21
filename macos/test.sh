#!/bin/bash
set -euo pipefail
SOURCE_ROOT="$(cd "$(dirname "$0")" && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mediashare-tests.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
python3 "$SOURCE_ROOT/Tests/make_fixtures.py" "$TEST_ROOT/fixtures"
xcrun swiftc -swift-version 5 -O "$SOURCE_ROOT/Sources/UpdatePolicy.swift" "$SOURCE_ROOT/Tests/UpdatePolicyTests.swift" -o "$TEST_ROOT/update-policy-tests"
"$TEST_ROOT/update-policy-tests" "$TEST_ROOT/fixtures"

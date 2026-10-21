#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_number="${MEDIASHARE_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"
if [[ ! "$build_number" =~ ^[0-9]{14}$ ]]; then
  echo 'MEDIASHARE_BUILD_NUMBER must be a 14-digit UTC timestamp.' >&2
  exit 1
fi
output="${MEDIASHARE_OUTPUT_DIR:-$PWD/build/macos}"
mkdir -p "$output"
app="$output/MediaShare.app"
if [[ -e "$app" ]]; then
  echo 'Use a fresh output directory; an existing app will not be overwritten.' >&2
  exit 1
fi
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp macos/Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
cp macos/Resources/MediaShare.icns macos/Resources/MediaShare.png "$app/Contents/Resources/"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
for architecture in x86_64 arm64; do
  xcrun swiftc -swift-version 5 -O -sdk "$sdk" -target "$architecture-apple-macosx12.0" \
    -framework Cocoa -framework WebKit -framework CryptoKit \
    macos/Sources/*.swift -o "$output/MediaShare-$architecture"
done
xcrun lipo -create "$output/MediaShare-x86_64" "$output/MediaShare-arm64" \
  -output "$app/Contents/MacOS/MediaShare"
chmod 755 "$app/Contents/MacOS/MediaShare"
# Match the supplied private app's ad-hoc signature. This is not Developer ID
# signing or Apple notarization, and does not change Gatekeeper settings.
/usr/bin/codesign --force --sign - --timestamp=none "$app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
xcrun lipo "$app/Contents/MacOS/MediaShare" -verify_arch x86_64 arm64
python3 macos/verify_package.py "$app"
python3 macos/package_app.py "$app" "$output/MediaShare-macOS.zip"
(cd "$output" && /usr/bin/shasum -a 256 MediaShare-macOS.zip > MediaShare-macOS.zip.sha256)
printf '%s\n' "$build_number" > "$output/build-number.txt"


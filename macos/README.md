# MediaShare for the iMac

This native macOS 12+ app replaces the old 1.1/build 2 wrapper. It supports Intel
and Apple Silicon and preserves the supplied `MediaShare.png` and `.icns` bytes.

The old wrapper loaded an older embedded HTML file. Current MediaShare uses
multiple JavaScript/CSS modules and server intake routes restricted to the
official browser origin. The new wrapper therefore loads
`https://firstupc.github.io/media/` directly, preserving that origin and normal
Firebase authentication. Website updates appear on the next launch/reload. It
requires internet access and the church server for uploads and extraction.

## Installation

Quit the old MediaShare app. Extract `MediaShare-macOS.zip`, then move
`MediaShare.app` into Applications, replacing the old copy. If that directory is
not writable by your Mac account, use your home folder's `Applications` folder.
Launch the installed copy, not a copy inside a downloaded ZIP or a disk image.
Keep the old app until you have checked the new installation.

Like the supplied app, this build is ad-hoc signed, not Apple notarized. macOS
may request your approval for a downloaded app. Use macOS Privacy & Security
controls if you trust this package; do not disable Gatekeeper. Native updates
never remove quarantine attributes or change security settings.

## Automatic updates

At launch, before the upload screen opens, the app checks this repository's
published `macos-` releases. A newer app shows a temporary download/install
window, validates the package, and installs it before automatically reopening.
An unavailable update service leaves the installed app usable. Update checks do
not interrupt a running upload session. A failed update retains the existing app.

Only full published native releases are installed, never pull requests or drafts.
Website changes deploy through the existing Pages workflow independently.
There is no login token, private credential, or administrator helper in the app.

Native packages are accepted only from this repository's HTTPS release URLs.
The updater verifies the SHA-256 checksum, archive paths, bundle identity/build,
code signature, and the exact original icon hashes before installation. The
checksum and release channel trust GitHub/repository access; ad-hoc signing is
not a Developer ID publisher identity guarantee.

`Build MediaShare for macOS` compiles and tests pull requests without publishing.
After these changes are merged, changes under `macos/` automatically build and
publish a native release on main only if both architecture checks pass. The
initial delivered app is a CI artifact; future automatic native updates require
this workflow to be merged and a newer release published. No release is
published by the pull-request build.

## Development

Run `bash macos/build.sh` on a Mac with Xcode command-line tools. The script
creates a universal app, verifies its ad-hoc signature and branding, and emits
the ZIP plus checksum in `build/macos`. Use a fresh output directory for each
build. `MEDIASHARE_BUILD_NUMBER` accepts a 14-digit UTC timestamp. Run
`bash macos/test.sh` for updater policy tests and the executable with
`--smoke-test` for an inert native WebKit check that does not touch church data.

CI launch and mocked update tests do not verify the iMac's OS, production upload
permissions, FUPCJ availability, model readiness, or a live service.

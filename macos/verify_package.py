"""Verify original branding, bundle metadata and archive safety without launching."""
import hashlib
import plistlib
import re
import sys
from pathlib import Path

app = Path(sys.argv[1])
expected = {
    "MediaShare.icns": "4adf3f3b026dfb8334bfdc4ab2f01e6984b8105452bba722a3e34c7c0fef1945",
    "MediaShare.png": "458683cbfbdcd901763d19e37ac0b5432e399ea2ea56c0db253aa797409bacd5",
}
for name, digest in expected.items():
    assert hashlib.sha256((app / "Contents/Resources" / name).read_bytes()).hexdigest() == digest, name
info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
assert info["CFBundleIdentifier"] == "org.firstupc.mediashare"
assert info["CFBundleExecutable"] == "MediaShare"
assert info["CFBundleIconFile"] == "MediaShare.icns"
assert info["LSMinimumSystemVersion"] == "12.0"
assert re.fullmatch(r"[0-9]{14}", info["CFBundleVersion"])
assert (app / "Contents/MacOS/MediaShare").stat().st_mode & 0o111
assert not any(p.is_symlink() for p in app.rglob("*"))
print("Bundle metadata, executable permission, and both original icon hashes verified.")


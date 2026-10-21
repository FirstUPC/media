"""Package the signed app using ordinary ZIP paths and Unix file permissions.

No resource forks or alternate-name extra fields are needed by this bundle.
The updater validates this exact archive before macOS extracts it.
"""
import pathlib
import stat
import sys
import zipfile

app = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
if app.name != "MediaShare.app" or not app.is_dir() or app.is_symlink():
    raise SystemExit("Expected a regular MediaShare.app directory")

paths = [app, *sorted(app.rglob("*"))]
for path in paths:
    mode = path.lstat().st_mode
    if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
        raise SystemExit(f"Unsupported bundle entry: {path}")

with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED,
                     compresslevel=9, allowZip64=False) as archive:
    for path in paths:
        archive.write(path, path.relative_to(app.parent).as_posix())

print(f"Packaged {len(paths)} regular bundle entries: {destination.name}")

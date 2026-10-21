"""Build inert archive fixtures; no downloaded release or executable is run."""
import pathlib
import stat
import struct
import sys
import warnings
import zipfile

root = pathlib.Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
base = [('MediaShare.app/Contents/Info.plist', b'plist'),
        ('MediaShare.app/Contents/MacOS/MediaShare', b'inert')]


def archive(name, extra=()):
    with zipfile.ZipFile(root / name, 'w', compression=zipfile.ZIP_STORED) as z:
        for path, content in [*base, *extra]:
            z.writestr(path, content)


archive('valid.zip')
archive('traversal.zip', [('MediaShare.app/../../outside', b'x')])
archive('wrong-root.zip', [('Other.app/Contents/file', b'x')])
symlink = zipfile.ZipInfo('MediaShare.app/Contents/link')
symlink.create_system = 3
symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
archive('symlink.zip', [(symlink, b'/tmp/outside')])
alias = zipfile.ZipInfo('MediaShare.app/Contents/safe.txt')
payload = b'\x01' + b'\x00' * 4 + b'../outside'
alias.extra = struct.pack('<HH', 0x7075, len(payload)) + payload
archive('unicode-alias.zip', [(alias, b'x')])
with warnings.catch_warnings():
    warnings.simplefilter('ignore')
    archive('duplicate.zip', [base[0]])

data = bytearray((root / 'valid.zip').read_bytes())
data[30] = ord('X')
(root / 'local-mismatch.zip').write_bytes(data)
data = bytearray((root / 'valid.zip').read_bytes())
central = data.index(b'PK\x01\x02')
struct.pack_into('<H', data, 6, 1)
struct.pack_into('<H', data, central + 8, 1)
(root / 'encrypted.zip').write_bytes(data)
data = bytearray((root / 'valid.zip').read_bytes())
struct.pack_into('<I', data, 22, 300 * 1024 * 1024)
struct.pack_into('<I', data, central + 24, 300 * 1024 * 1024)
(root / 'oversize.zip').write_bytes(data)
data = bytearray((root / 'valid.zip').read_bytes())
data[14] ^= 1
(root / 'crc-mismatch.zip').write_bytes(data)

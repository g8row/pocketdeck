# Turn a raw dump of the TB-7304X framebuffer (600x1024 portrait, XRGB8888 / BGRA bytes) into a landscape PNG,
# the way the PocketJS kiosk shows it. Standard library only.
#   mainline/scripts/tb.sh 'cat /dev/fb0' > fb.raw && python3 -I mainline/scripts/fb2png.py fb.raw fb.png
import struct
import sys
import zlib

W, H = 600, 1024
d = open(sys.argv[1], 'rb').read()
rows = []
for y2 in range(W):              # landscape row = panel column, right to left
    row = bytearray(b'\0')
    for x2 in range(H):          # landscape column = panel row
        o = (x2 * W + (W - 1 - y2)) * 4
        row += bytes((d[o + 2], d[o + 1], d[o]))
    rows.append(bytes(row))
def chunk(t, b):
    return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', H, W, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(b''.join(rows), 6)) + chunk(b'IEND', b''))
open(sys.argv[2], 'wb').write(png)

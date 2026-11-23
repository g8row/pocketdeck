#!/usr/bin/env python3
# Test patterns for mapping panel damage (dead pixels, cracks) into UI coordinates. Standard library only.
# Writes a raw frame for the tablet's fb0 (600x1024 portrait, BGRX) to stdout, drawn in the UI's landscape
# LOGICAL coordinates (512x300, 2 physical px per logical px), so a photo of it reads off directly in UI units.
#
#   tools/panel-grid.py grid  | tools/tb.sh 'cat > /dev/fb0'    white, minor lines every 8, labelled majors every 32
#   tools/panel-grid.py white|black|red|green|blue | ...        solid fill (dead / stuck pixels)
# The UI must be stopped first (pd ssh 'rc-service pocketdeck-ui stop'), and started again afterwards.
import sys

PW, PH = 600, 1024          # panel, portrait
LW, LH = 1024, 600          # landscape physical
S = 2                       # physical px per logical px
FONT = {                    # 3x5 digits
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001001001',
    '8': '111101111101111', '9': '111101111001111',
}
COLORS = {'white': (255, 255, 255), 'black': (0, 0, 0), 'red': (255, 0, 0), 'green': (0, 255, 0), 'blue': (0, 0, 255)}

mode = sys.argv[1] if len(sys.argv) > 1 else 'grid'
bg = COLORS.get(mode, (255, 255, 255))
img = [[bg] * LW for _ in range(LH)]          # landscape, physical pixels


def px(x, y, c):
    if 0 <= x < LW and 0 <= y < LH:
        img[y][x] = c


def text(lx, ly, s, c, scale=2):
    """Digits at logical (lx, ly), top-left; each font dot = `scale` physical px."""
    x0, y0 = lx * S, ly * S
    for i, ch in enumerate(s):
        bits = FONT[ch]
        for r in range(5):
            for col in range(3):
                if bits[r * 3 + col] == '1':
                    for dy in range(scale):
                        for dx in range(scale):
                            px(x0 + (i * 4 + col) * scale + dx, y0 + r * scale + dy, c)


if mode == 'grid':
    minor, major, label = (200, 200, 200), (0, 0, 0), (200, 0, 0)
    for lx in range(0, 512, 8):
        c = major if lx % 32 == 0 else minor
        for y in range(LH):
            px(lx * S, y, c)
    for ly in range(0, 300, 8):
        c = major if ly % 32 == 0 else minor
        for x in range(LW):
            px(x, ly * S, c)
    for x in (511 * S, 511 * S + 1):           # right and bottom edge
        for y in range(LH):
            px(x, y, major)
    for y in (299 * S, 299 * S + 1):
        for x in range(LW):
            px(x, y, major)
    # labels: x along the top, middle and bottom; y along the left, middle and right
    for lx in range(32, 512, 32):
        for ly in (2, 146, 290):
            text(lx + 2, ly, str(lx), label)
    for ly in range(32, 300, 32):
        for lx in (2, 258, 496):
            text(lx, ly - 7, str(ly), label)

out = bytearray(PW * PH * 4)
for y in range(LH):                            # landscape (x, y) -> panel (599 - y, x)
    row = img[y]
    pxl = PW - 1 - y
    for x in range(LW):
        r, g, b = row[x]
        o = (x * PW + pxl) * 4
        out[o:o + 4] = bytes((b, g, r, 0))
sys.stdout.buffer.write(out)

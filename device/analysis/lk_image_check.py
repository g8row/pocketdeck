#!/usr/bin/env python3
# Offline model of what the TB-7304X stock LK (lk.bin, built Aug 28 2018) does with a 64-bit Android boot image
# in `boot` or `recovery`. Every rule cites the LK address it was read from; see
# docs/mainline/research-lk-bootflow.md. Exit status 0 = LK will boot it deterministically, 1 = it will not
# (or only by luck, using a DTB left in RAM by the previous boot).
#
#   lk_image_check.py <image> [<image> ...]        (an image file or a raw 16 MiB partition dump)
import struct, sys, zlib

PART_SIZE = 16 << 20          # boot and recovery are 16 MiB on this tablet
SCAN_WIN = 0x80000            # bldr_load_dtb reads the last 512 KiB of the kernel area (0x41e1f318)
MAX_KERNEL = 0x1c00000        # decompress limit passed at 0x41e1f5c8
SCRATCH = 0x45000000          # target_get_scratch_address() = load address of the image body (0x41e04468)
FB_BASE = 0x7f7b0000          # tags + DTB must end below the LK framebuffer (0x41e1f622)


def check(path):
    d = open(path, 'rb').read()
    bad, warn, info = [], [], []
    if d[:8] != b'ANDROID!':
        return ['no ANDROID! magic: LK prints "boot image header magic error" and resets after 8 s (0x41e035c0)'], [], []
    ks, ka, rs, ra, ss, sa, ta, ps = struct.unpack_from('<8I', d, 8)
    cmd = d[0x40:0x240].split(b'\0')[0]
    info.append('kernel %#x @ %#x, ramdisk %#x @ %#x, second %#x, tags %#x, page %#x' % (ks, ka, rs, ra, ss, ta, ps))

    # bootopt (0x41e1f18c): first "bootopt=" whose 3rd field (offset +0x12) is "64" or "32"
    is64 = None
    i = cmd.find(b'bootopt=')
    while i >= 0 and is64 is None:
        f = cmd[i + 0x12:i + 0x14]
        is64 = True if f == b'64' else False if f == b'32' else None
        i = cmd.find(b'bootopt=', i + 1)
    if is64 is None:
        bad.append('no usable bootopt= in the header cmdline: LK treats it as a 32-bit kernel ("Warning! No bootopt info!")')
        return bad, warn, info
    if not is64:
        bad.append('bootopt says 32-bit; this model only covers the 64-bit path')
        return bad, warn, info
    if len(cmd) > 99:
        warn.append('header cmdline is %d chars; LK copies only 99 (snprintf 100 at 0x41e20396)' % len(cmd))

    # 64-bit kernel must sit on a 512 KiB boundary (0x41e1f4e2: ubfx #0,#19 -> "64 bit kernel can't boot at ...", hang)
    if ka & 0x7ffff:
        bad.append('kernel_addr %#x not 512 KiB aligned: LK hangs ("64 bit kernel can\'t boot at ...")' % ka)

    # bldr_load_dtb (0x41e1f20c): the DTB LK patches and hands over is read from the PARTITION here, not from RAM.
    off = (ks + 2 * ps - SCAN_WIN - 1) & ~(ps - 1) & 0xffffffff
    if off + SCAN_WIN > PART_SIZE:
        bad.append('kernel area %#x < %#x: bldr_load_dtb reads at %#x (u32 underflow), partition_read rejects it '
                   '("Incorrect range"), and LK boots with whatever DTB the PREVIOUS boot left at tags %#x '
                   '(works only by luck)' % (ks, SCAN_WIN - 2 * ps + 1, off, ta))
        tagdtb = None
    else:
        win = d[off:off + SCAN_WIN]
        pos = None
        for p in range(SCAN_WIN - 4, 0, -1):           # 0x41e1f350: backwards from +0x7fffc, stops before +0
            if win[p:p + 4] == b'\xd0\x0d\xfe\xed':
                pos = p
                break
        if pos is None:
            bad.append('no FDT magic in the last 512 KiB of the kernel area: "can\'t find dtb", stale RAM DTB used')
            tagdtb = None
        else:
            tsz = struct.unpack_from('>I', win, pos + 4)[0]
            tagdtb = win[pos:pos + tsz]
            info.append('bldr_load_dtb: FDT at image offset %#x, %d bytes -> copied to tags %#x' % (off + pos, tsz, ta))
            if tsz > 0x200000 or len(tagdtb) != tsz:
                bad.append('FDT size %#x does not fit (fdt_open_into to 2 MiB at 0x41e1f2e8)' % tsz)

    # boot_linux_fdt 64-bit (0x41e1f4ea): scan the kernel blob (loaded at SCRATCH+page) backwards for an
    # appended FDT; it only sizes the zImage. No appended FDT -> fp=0 -> "Can't find device tree", hang.
    kb = d[ps:ps + ks]
    p = kb.rfind(b'\xd0\x0d\xfe\xed')
    if p < 0:
        bad.append('no FDT appended to the kernel: LK hangs ("Can\'t find device tree", 0x41e1f594)')
    else:
        zsz = ks - ((ks - p + 3) & ~3)
        z = kb[:zsz]
        if not (z[:2] == b'\x1f\x8b' and z[2] == 8 and not z[3] & 0xe0):
            bad.append('kernel is not gzip: "gzip header is not correct" (0x41e20828), hang')
        else:
            # 0x41e207cc skips the gzip header by hand, then 0x41e2071c runs raw inflate (inflateInit2 -15) and
            # wants Z_STREAM_END; the gzip trailer and anything after the stream are never looked at.
            fl, h = z[3], 10
            if fl & 4: h += 2 + z[10] + (z[11] << 8)
            if fl & 8: h = z.index(b'\0', h) + 1
            if fl & 16: h = z.index(b'\0', h) + 1
            if fl & 2: h += 2
            try:
                o = zlib.decompressobj(-15)
                out = o.decompress(z[h:], MAX_KERNEL + 1)
                if not o.eof:
                    bad.append('gzip stream does not end inside the zImage part: inflate() error, hang')
                elif len(out) > MAX_KERNEL:
                    bad.append('decompressed kernel > 28 MiB')
                else:
                    info.append('gunzip %d -> %d bytes at %#x (%d bytes after the stream ignored)'
                                % (zsz, len(out), ka, len(o.unused_data)))
                    if ka < 0x41e00000 < ka + len(out):
                        bad.append('decompressed kernel overlaps LK at 0x41e00000')
            except zlib.error as e:
                bad.append('inflate error: %s' % e)
    if ta + 0x200000 > FB_BASE:
        bad.append('tags + 2 MiB overlaps the framebuffer')
    if SCRATCH < ta < SCRATCH + ps + ks + rs:
        bad.append('tags %#x lies inside the loaded image at %#x' % (ta, SCRATCH))
    return bad, warn, info


rc = 0
for f in sys.argv[1:]:
    bad, warn, info = check(f)
    print('== %s: %s' % (f, 'FAIL' if bad else 'OK'))
    for x in info: print('   ', x)
    for x in warn: print('   WARN', x)
    for x in bad: print('   FAIL', x)
    rc |= bool(bad)
sys.exit(rc)

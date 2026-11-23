#!/usr/bin/env python3
# Build the TB-7304X dual-boot GPT (docs/mainline/plan-dualboot.md §2) from a dump of the current one.
#
#   tb-gpt.py build <first-512k-dump> <last-1m-dump> <outdir>
#       writes <outdir>/primary-lba1-9.bin (header + entries, LBA 1..9), <outdir>/backup-entries.bin (LBA
#       30534656..), <outdir>/backup-header.bin (last LBA) and <outdir>/layout.txt
#   tb-gpt.py show <first-512k-dump> [<last-1m-dump>]
#       parses and checks (CRCs, overlaps, primary == backup) a primary and optionally a backup GPT
#
# Only userdata's last LBA changes; entries 24-30 are appended; MBR, disk GUID and entries 1-23 stay byte-identical.
import struct, sys, uuid, zlib, os

SECTOR = 512
DISK_SECTORS = 30535680
LINUX_FS = uuid.UUID('0fc63daf-8483-4772-8e79-3d69d8477de4')
MIB = 2048  # sectors

USERDATA_START = 10207232
USERDATA_SIZE = 3072 * MIB
FLASHINFO_START = 30501888
NEW = [  # name, size in MiB (None = the rest up to flashinfo)
    ('tbstate', 1), ('tbkern_a', 64), ('tbkern_b', 64), ('tbrescue', 64),
    ('tbroot_a', 2048), ('tbroot_b', 2048), ('tbdata', None),
]


def parse(buf, hdr_off, entries_buf):
    h = buf[hdr_off:hdr_off + 92]
    assert h[:8] == b'EFI PART', 'no GPT header'
    hsize = struct.unpack_from('<I', h, 12)[0]
    hdr = bytearray(buf[hdr_off:hdr_off + hsize])
    crc = struct.unpack_from('<I', hdr, 16)[0]
    struct.pack_into('<I', hdr, 16, 0)
    assert zlib.crc32(hdr) == crc, 'header CRC'
    my, alt, first, last = struct.unpack_from('<QQQQ', h, 24)
    disk_guid = h[56:72]
    ent_lba, n, esz, ecrc = struct.unpack_from('<QIII', h, 72)
    ents = entries_buf[:n * esz]
    assert zlib.crc32(ents) == ecrc, 'entries CRC'
    parts = []
    for i in range(n):
        e = ents[i * esz:(i + 1) * esz]
        if e[:16] == b'\0' * 16:
            parts.append(None)
            continue
        f, l = struct.unpack_from('<QQ', e, 32)
        parts.append(dict(type=e[:16], guid=e[16:32], first=f, last=l, attr=e[48:56],
                          name=e[56:128].decode('utf-16le').rstrip('\0'), raw=e))
    return dict(my=my, alt=alt, first=first, last=last, disk_guid=disk_guid, ent_lba=ent_lba, n=n, esz=esz,
                parts=parts, hsize=hsize)


def parse_backup(b):
    """b = the last len(b) bytes of the disk; the backup header is in its last sector"""
    base = DISK_SECTORS - len(b) // SECTOR
    hoff = len(b) - SECTOR
    ent_lba = struct.unpack_from('<Q', b, hoff + 72)[0]
    assert base <= ent_lba < DISK_SECTORS - 1, 'backup entries outside the dump'
    return parse(b, hoff, b[(ent_lba - base) * SECTOR:])


def check(g):
    ps = [p for p in g['parts'] if p]
    for p in ps:
        assert g['first'] <= p['first'] <= p['last'] <= g['last'], 'out of usable range: %s' % p['name']
    s = sorted(ps, key=lambda p: p['first'])
    for a, b in zip(s, s[1:]):
        assert a['last'] < b['first'], 'overlap %s / %s' % (a['name'], b['name'])
    names = [p['name'] for p in ps]
    assert len(names) == len(set(names)), 'duplicate names'
    assert all(len(n) <= 36 for n in names), 'name > 36 chars (LK copies 36)'


def show(g, title):
    print('%s: my %d alt %d usable %d..%d entries@%d n=%d' % (title, g['my'], g['alt'], g['first'], g['last'],
                                                              g['ent_lba'], g['n']))
    for i, p in enumerate(g['parts']):
        if p:
            print('  %2d %-10s %10d %10d %9.1f MiB' % (i + 1, p['name'], p['first'], p['last'],
                                                      (p['last'] - p['first'] + 1) / MIB))


def entry(name, first, last, type_guid=LINUX_FS):
    e = bytearray(128)
    e[0:16] = type_guid.bytes_le
    e[16:32] = uuid.uuid4().bytes_le
    struct.pack_into('<QQ', e, 32, first, last)
    e[56:56 + 2 * len(name)] = name.encode('utf-16le')
    return bytes(e)


def header(g, my, alt, ent_lba, n, ents):
    h = bytearray(g['hsize'])
    h[0:8] = b'EFI PART'
    struct.pack_into('<II', h, 8, 0x00010000, g['hsize'])
    struct.pack_into('<QQQQ', h, 24, my, alt, g['first'], g['last'])
    h[56:72] = g['disk_guid']
    struct.pack_into('<QIII', h, 72, ent_lba, n, 128, zlib.crc32(ents))
    struct.pack_into('<I', h, 16, zlib.crc32(h))
    return bytes(h) + b'\0' * (SECTOR - len(h))


def main():
    if sys.argv[1] == 'show':
        p = open(sys.argv[2], 'rb').read()
        g = parse(p, SECTOR, p[2 * SECTOR:])
        check(g); show(g, 'primary')
        if len(sys.argv) > 3:
            gb = parse_backup(open(sys.argv[3], 'rb').read())
            check(gb); show(gb, 'backup')
            same = [x['raw'] for x in gb['parts'] if x] == [x['raw'] for x in g['parts'] if x]
            print('backup entries == primary entries:', same)
            assert same and gb['my'] == g['alt'] and gb['alt'] == g['my']
        return
    _, _, pfile, bfile, out = sys.argv
    p = open(pfile, 'rb').read()
    b = open(bfile, 'rb').read()
    g = parse(p, SECTOR, p[2 * SECTOR:])
    check(g)
    assert g['n'] == 23, 'expected the stock 23-entry table'
    ud = [i for i, x in enumerate(g['parts']) if x and x['name'] == 'userdata'][0]
    fi = [i for i, x in enumerate(g['parts']) if x and x['name'] == 'flashinfo'][0]
    assert g['parts'][ud]['first'] == USERDATA_START and g['parts'][fi]['first'] == FLASHINFO_START
    assert not any(x and x['name'].startswith('tb') for x in g['parts']), 'already repartitioned'
    # backup GPT as found on the disk: must describe the same table
    base = DISK_SECTORS - len(b) // SECTOR
    gb = parse_backup(b)
    assert [x['raw'] for x in gb['parts'] if x] == [x['raw'] for x in g['parts'] if x], 'backup != primary'
    bak_ent_lba = gb['ent_lba']

    ents = [x['raw'] for x in g['parts']]
    u = bytearray(ents[ud])
    struct.pack_into('<Q', u, 40, USERDATA_START + USERDATA_SIZE - 1)
    ents[ud] = bytes(u)
    lba = USERDATA_START + USERDATA_SIZE
    for name, mib in NEW:
        last = FLASHINFO_START - 1 if mib is None else lba + mib * MIB - 1
        ents.append(entry(name, lba, last))
        lba = last + 1
    assert lba == FLASHINFO_START
    n = len(ents)
    earr = b''.join(ents)
    nsec = (len(earr) + SECTOR - 1) // SECTOR
    epad = earr + b'\0' * (nsec * SECTOR - len(earr))
    assert 2 + nsec <= g['first'] and bak_ent_lba + nsec <= DISK_SECTORS - 1
    os.makedirs(out, exist_ok=True)
    prim = header(g, 1, g['alt'], 2, n, earr) + epad
    open(out + '/primary-lba1-9.bin', 'wb').write(prim + b'\0' * (9 * SECTOR - len(prim)))
    open(out + '/backup-entries.bin', 'wb').write(epad)
    open(out + '/backup-header.bin', 'wb').write(header(g, g['alt'], 1, bak_ent_lba, n, earr))
    # self-check: parse what we wrote
    chk = b'\0' * SECTOR + open(out + '/primary-lba1-9.bin', 'rb').read()
    g2 = parse(chk, SECTOR, chk[2 * SECTOR:])
    check(g2)
    with open(out + '/layout.txt', 'w') as f:
        sys.stdout = f
        show(g2, 'new primary')
        print('backup entries at LBA %d (%d sectors), backup header at LBA %d' % (bak_ent_lba, nsec, g['alt']))
    sys.stdout = sys.__stdout__
    print(open(out + '/layout.txt').read())


if __name__ == '__main__':
    main()

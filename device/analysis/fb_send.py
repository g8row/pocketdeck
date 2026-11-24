# Minimal pyusb fastboot client for the TB-7304X LK: upload a file with `download:`, then send one command.
# The stock `fastboot` binary stalls in the data phase on this LK, but raw pyusb transfers work (see fb_probe.py).
# usage: python -I fb_send.py <file> [command]      e.g.  fb_send.py out/boot.img boot
#        python -I fb_send.py - <command>            no upload, just send the command (e.g. "oem reboot-recovery")
# Linux: pip install pyusb; needs USB access (plugdev / udev rule for 0bb4:0c01, or root).
import os, sys, time, usb.core, usb.util, usb.backend.libusb1 as lb

path = sys.argv[1]
command = sys.argv[2] if len(sys.argv) > 2 else None
CHUNK = 1 << 20
BREW = '/opt/homebrew/lib/libusb-1.0.dylib'
be = lb.get_backend(find_library=lambda _: BREW) if os.path.exists(BREW) else lb.get_backend()
T0 = time.time()
def log(*a): print('%7.3f' % (time.time() - T0), *a, flush=True)

dev = None
for d in usb.core.find(find_all=True, backend=be):
    for cfg in d:
        for itf in cfg:
            if (itf.bInterfaceClass, itf.bInterfaceSubClass, itf.bInterfaceProtocol) == (0xff, 0x42, 0x03):
                dev, intf = d, itf
if dev is None: sys.exit('no fastboot interface found')
ep_out = usb.util.find_descriptor(intf, custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT)
ep_in = usb.util.find_descriptor(intf, custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN)
usb.util.claim_interface(dev, intf.bInterfaceNumber)

def reply(t):
    while True:
        r = bytes(dev.read(ep_in, 256, t)).decode(errors='replace'); log('<<', repr(r))
        if not r.startswith('INFO'): return r

def cmd(s, t=5000):
    log('>>', s); dev.write(ep_out, s.encode(), t); return reply(t)

rc = 1
try:
    cmd('getvar:version')
    if path != '-':
        data = open(path, 'rb').read()
        r = cmd('download:%08x' % len(data))
        if not r.startswith('DATA'): sys.exit('no DATA reply')
        for off in range(0, len(data), CHUNK):
            dev.write(ep_out, data[off:off + CHUNK], 10000)
        log('sent %d bytes' % len(data))
        r = reply(15000)
        if not r.startswith('OKAY'): sys.exit('download failed')
    if command:
        r = cmd(command, 15000)
        rc = 0 if r.startswith('OKAY') else 2
    else:
        rc = 0
except usb.core.USBError as e:
    log('USB ERROR:', e)
finally:
    try: usb.util.release_interface(dev, intf.bInterfaceNumber)
    except usb.core.USBError: pass
sys.exit(rc)

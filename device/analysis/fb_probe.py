# Raw fastboot protocol probe for the TB-7304X LK (pyusb + libusb, every step has a timeout).
# Shows which phase of `download:` stalls: command write, DATA reply, payload write, or final OKAY.
# usage: tools/venv/bin/python -I fb_probe.py [size_bytes] [chunk_bytes]
# Linux: pip install pyusb (libusb-1.0 from the distro); run as root or with a udev rule for 0bb4/0e8d.
import os, sys, time, usb.core, usb.util, usb.backend.libusb1 as lb

size = int(sys.argv[1], 0) if len(sys.argv) > 1 else 16
chunk = int(sys.argv[2], 0) if len(sys.argv) > 2 else 512
BREW = '/opt/homebrew/lib/libusb-1.0.dylib'
be = lb.get_backend(find_library=lambda _: BREW) if os.path.exists(BREW) else lb.get_backend()

def log(*a): print('%7.3f' % (time.time() - T0), *a, flush=True)
T0 = time.time()

dev = None
for d in usb.core.find(find_all=True, backend=be):
    for cfg in d:
        for itf in cfg:
            if (itf.bInterfaceClass, itf.bInterfaceSubClass, itf.bInterfaceProtocol) == (0xff, 0x42, 0x03):
                dev, intf = d, itf
if dev is None: sys.exit('no fastboot interface found')
log('device %04x:%04x speed=%s' % (dev.idVendor, dev.idProduct, dev.speed))
ep_out = usb.util.find_descriptor(intf, custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_OUT)
ep_in = usb.util.find_descriptor(intf, custom_match=lambda e: usb.util.endpoint_direction(e.bEndpointAddress) == usb.util.ENDPOINT_IN)
log('intf %d  OUT %#x maxpkt=%d  IN %#x maxpkt=%d' % (intf.bInterfaceNumber, ep_out.bEndpointAddress, ep_out.wMaxPacketSize, ep_in.bEndpointAddress, ep_in.wMaxPacketSize))
usb.util.claim_interface(dev, intf.bInterfaceNumber)

def cmd(s, t=3000):
    log('>>', s); dev.write(ep_out, s.encode(), t)
    while True:
        r = bytes(dev.read(ep_in, 256, t)).decode(errors='replace'); log('<<', repr(r))
        if not r.startswith('INFO'): return r

try:
    cmd('getvar:version')
    r = cmd('download:%08x' % size, 5000)
    if not r.startswith('DATA'): sys.exit('no DATA reply')
    payload = bytes((i * 7) & 0xff for i in range(size)); sent = 0
    while sent < size:
        n = dev.write(ep_out, payload[sent:sent + chunk], 5000); sent += n
        log('payload write %d (total %d/%d)' % (n, sent, size))
    log('waiting for final reply'); r = bytes(dev.read(ep_in, 256, 10000)).decode(errors='replace'); log('<<', repr(r))
    cmd('getvar:version')
except usb.core.USBError as e:
    log('USB ERROR:', e)
finally:
    usb.util.release_interface(dev, intf.bInterfaceNumber)

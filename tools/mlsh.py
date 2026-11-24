# Shell access to the TB-7304X sign-of-life initramfs over USB ethernet (telnet on 172.16.42.1, no login).
#   python3 -I mlsh.py wait            wait for telnet on the gadget, then touch /tmp/stay
#   python3 -I mlsh.py 'cmd' ['cmd'..]  run commands, print their output
# Serial (/dev/ttyACM0) also works, but ModemManager on the host tends to grab it.
import socket, subprocess, sys, time, glob, os

HOST = '172.16.42.1'
MARK = '__MLSH_DONE__'

def ifaces():
    return [os.path.basename(p) for p in glob.glob('/sys/class/net/enx*')]

def bring_up(deadline):
    while time.time() < deadline:
        # Host side must already have 172.16.42.2/24 on the enx* interface (see README: tb7304x-usb nmcli profile).
        # Never `nmcli d connect` here: it can move the host's main wired profile onto the tablet link.
        try:
            socket.create_connection((HOST, 23), 1).close(); return True
        except OSError:
            time.sleep(1)
    return False

def strip_iac(b):
    out, i = bytearray(), 0
    while i < len(b):
        if b[i] == 255 and i + 2 < len(b): i += 3; continue
        out.append(b[i]); i += 1
    return bytes(out)

def run(cmds, timeout=30):
    s = socket.create_connection((HOST, 23), 5); s.settimeout(timeout)
    s.sendall(b'stty -echo 2>/dev/null; PS1=\n')
    for c in cmds:
        s.sendall(("%s; echo __MLSH''_DONE__\n" % c).encode())   # quoted so the echoed command line has no marker
        buf = b''
        while MARK.encode() + b'\r\n' not in buf and MARK.encode() + b'\n' not in buf:
            d = s.recv(65536)
            if not d: break
            buf += d
        txt = strip_iac(buf).decode(errors='replace').replace('\r', '')
        txt = txt.split('PS1=\n')[-1]
        print(txt.split(MARK)[0].rstrip('\n'), flush=True)
    s.close()

if __name__ == '__main__':
    if sys.argv[1:] == ['wait']:
        if not bring_up(time.time() + 240): sys.exit('no gadget')
        run(['touch /tmp/stay; uptime; cat /proc/cmdline | head -c 80'])
    else:
        run(sys.argv[1:])

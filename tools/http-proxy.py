# Minimal HTTP/HTTPS forward proxy for the tablet (apk, wget, curl). Listens on 127.0.0.1 only; the tablet reaches
# it through `ssh -R 3128:127.0.0.1:3128` (see tablet-net.sh), so no host network or firewall config changes.
#   python3 -I http-proxy.py [port]
# Absolute-URI requests (http://, and https:// as busybox wget sends them) are forwarded with Connection: close;
# CONNECT is tunnelled. The tablet's clock may be wrong, so TLS to the origin is verified here on the host.
import socket, ssl, sys, threading, select
from urllib.parse import urlsplit

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3128

def pipe(a, b):
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, 300)
            if x or not r:
                return
            for s in r:
                d = s.recv(65536)
                if not d:
                    return
                while getattr(s, 'pending', lambda: 0)():   # TLS keeps decrypted bytes select() can't see
                    d += s.recv(s.pending())
                (b if s is a else a).sendall(d)
    except OSError:
        pass

def handle(c):
    try:
        buf = b''
        while b'\r\n\r\n' not in buf:
            d = c.recv(65536)
            if not d:
                return
            buf += d
            if len(buf) > 65536:
                return
        head, rest = buf.split(b'\r\n\r\n', 1)
        lines = head.decode('latin-1').split('\r\n')
        method, target, ver = lines[0].split(' ', 2)
        if method == 'CONNECT':
            host, port = target.rsplit(':', 1)
            u = socket.create_connection((host, int(port)), 15)
            c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
            if rest:
                u.sendall(rest)
        else:
            p = urlsplit(target)
            if p.scheme not in ('http', 'https') or not p.hostname:
                c.sendall(b'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
                return
            # busybox wget sends `GET https://...` to an https_proxy instead of CONNECT: do the TLS here
            u = socket.create_connection((p.hostname, p.port or (443 if p.scheme == 'https' else 80)), 15)
            if p.scheme == 'https':
                u = ssl.create_default_context().wrap_socket(u, server_hostname=p.hostname)
            path = (p.path or '/') + ('?' + p.query if p.query else '')
            hdrs = [l for l in lines[1:] if not l.lower().startswith(('proxy-', 'connection:', 'keep-alive:'))]
            req = '\r\n'.join(['%s %s %s' % (method, path, ver)] + hdrs + ['Connection: close', '', ''])
            u.sendall(req.encode('latin-1') + rest)
        pipe(c, u)
        u.close()
    except Exception as e:
        print('proxy:', e, file=sys.stderr)
    finally:
        c.close()

s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', PORT))
s.listen(32)
print('proxy on 127.0.0.1:%d' % PORT, flush=True)
while True:
    conn, _ = s.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()

# Usage: python3.11 -I fb2png.py raw out.png  (raw = "pan\n" + fb0 bytes)
# Decodes the visible mtkfb buffer (600x1024 BGRA, stride 2432) and rotates it
# back to the landscape view the user sees.
import sys, zlib, struct
raw=open(sys.argv[1],'rb').read(); nl=raw.index(b'\n')
y0=int(raw[:nl].decode().split(',')[1]); data=raw[nl+1:]
W,H,S=600,1024,2432
buf=data[y0*S:(y0+H)*S]
out=[]
for ly in range(W):            # landscape rows = panel columns (px = W-1-ly)
    px=W-1-ly; row=bytearray()
    for lx in range(H):        # landscape cols = panel rows
        o=lx*S+px*4; row+=bytes((buf[o+2],buf[o+1],buf[o],255))
    out.append(bytes(row))
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
open(sys.argv[2],'wb').write(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',H,W,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+r for r in out),6))+chunk(b'IEND',b''))

# Lists code in MTK LK (lk.bin) that builds pointers to strings in [lo,hi) (vaddr, hex).
# lk.bin: 0x200-byte MTK header, code linked at 0x41E00000 (reset-vector literals).
# The code is PIC Thumb-2: "ldr{.w} Rt,[pc,#imm]; ... add Rt, pc".
import struct, sys
b=open(sys.argv[1],'rb').read(); BASE=0x41E00000; code=b[0x200:0x200+0x57818]
lo,hi=int(sys.argv[2],16),int(sys.argv[3],16)
res=[]
for i in range(0,len(code)-4,2):
    h=struct.unpack_from('<H',code,i)[0]
    if (h&0xF800)==0x4800:                       # LDR Rt,[PC,#imm8*4] (16-bit)
        rt=(h>>8)&7; lit=((i+4)&~3)+(h&0xFF)*4; nxt=i+2
    elif h in (0xF8DF,0xF85F):                   # LDR.W Rt,[PC,#+-imm12]
        h2=struct.unpack_from('<H',code,i+2)[0]; rt=h2>>12; imm=h2&0xFFF
        lit=((i+4)&~3)+(imm if h==0xF8DF else -imm); nxt=i+4
    else: continue
    if not 0<=lit<=len(code)-4: continue
    val=struct.unpack_from('<I',code,lit)[0]
    for j in range(nxt,nxt+24,2):
        h2=struct.unpack_from('<H',code,j)[0]
        if (h2&0xFF78)==0x4478 and ((h2&7)|((h2>>4)&8))==rt:   # ADD Rdn, PC
            t=(j+4+val)&0xFFFFFFFF
            if lo<=BASE+t<hi:
                e=code.find(b'\0',t); res.append((BASE+i,BASE+t,code[t:e][:70]))
            break
for a,v,s in sorted(res): print(hex(a),hex(v),s)

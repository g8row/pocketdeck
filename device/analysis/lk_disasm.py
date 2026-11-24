# Disassemble a Thumb-2 range of LK (vaddr) and annotate pc-relative string pointers.
import sys, struct
from capstone import *
b=open(sys.argv[1],'rb').read(); BASE=0x41E00000; code=b[0x200:0x200+0x57818]
lo,hi=int(sys.argv[2],16),int(sys.argv[3],16)
md=Cs(CS_ARCH_ARM,CS_MODE_THUMB); md.detail=False
lits={}
for ins in md.disasm(code[lo-BASE:hi-BASE],lo):
    note=''
    if ins.mnemonic.startswith('ldr') and '[pc, #' in ins.op_str:
        imm=int(ins.op_str.split('#')[1].rstrip(']'),0); a=((ins.address+4)&~3)+imm
        val=struct.unpack_from('<I',code,a-BASE)[0]; note='; lit=%#x'%val
        lits[ins.op_str.split(',')[0]]=val
    if ins.mnemonic.startswith('add') and ins.op_str.endswith(', pc'):
        r=ins.op_str.split(',')[0]
        if r in lits:
            t=(ins.address+4+lits[r])&0xffffffff; o=t-BASE
            if 0<=o<len(code): note='; -> %#x %r'%(t,code[o:code.find(b'\0',o)][:60])
    print('%#x: %-8s %s %s'%(ins.address,ins.mnemonic,ins.op_str,note))

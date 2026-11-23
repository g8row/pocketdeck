// SPDX-License-Identifier: GPL-2.0
/*
 * TB-7304X: boot Android from U-Boot with the device tree LK prepared.
 *
 * LK loads the U-Boot image like a kernel: it takes the DTB appended to the image (the stock Android DTB, see
 * build-uboot.sh), fills /chosen (bootargs with androidboot.*, atag,boot/mem/videolfb/mdinfo/..., initrd) and
 * the memory map, and passes it in x0. tb7304x_entry.S stores x0 in tb_lk_fdt. U-Boot itself runs on its own
 * control DT (OF_SEPARATE), so LK's tree stays untouched until `tbandroid` hands it to the Android kernel.
 *
 * bootm is not used for Android: it would rewrite the memory node (U-Boot hides LK's framebuffers) and
 * /chosen/bootargs, both of which the stock 3.18 kernel takes from LK.
 */
#include <common.h>
#include <command.h>
#include <cpu_func.h>
#include <env.h>
#include <gzip.h>
#include <image.h>
#include <android_image.h>
#include <mapmem.h>
#include <dm.h>
#include <dm/root.h>
#include <linux/libfdt.h>
#include <asm/io.h>
#include <asm/system.h>

/* x0 from LK, stored by tb7304x_entry.S before .bss exists; must live in .data */
unsigned long tb_lk_fdt __section(".data");
/* OVL0 layer controls as LK left them (tb7304x_debug.c), restored before Android starts */
u32 tb_ovl_l0con __section(".data");
u32 tb_ovl_l3con __section(".data");

#define OVL0_L0_CON		0x14007030
#define OVL0_L3_CON		0x14007090

#define LK_ATAG_BOOT		0x41000802
#define LK_BOOTMODE_NORMAL	0
#define LK_BOOTMODE_RECOVERY	2

/* the stock kernel must stay below ATF (0x43000000); the DTB moves out of every load range */
#define TB_KERNEL_LIMIT		0x43000000UL
#define TB_FDT_NEW		0x4f000000UL
#define TB_FDT_GROW		0x2000

/* atag,boot as LK writes it: raw little-endian words { size, ATAG_BOOT, bootmode, ... } */
static u32 *tb_bootmode(void *fdt)
{
	int off = fdt_path_offset(fdt, "/chosen"), len;
	u32 *p;

	if (off < 0)
		return NULL;
	p = fdt_getprop_w(fdt, off, "atag,boot", &len);
	if (!p || len < 12 || le32_to_cpu(p[1]) != LK_ATAG_BOOT)
		return NULL;
	return &p[2];
}

static u64 tb_prop_u(const void *fdt, int off, const char *name, int *lenp)
{
	const fdt32_t *p = fdt_getprop(fdt, off, name, lenp);

	if (!p)
		return 0;
	if (*lenp == 8)
		return fdt64_to_cpu(*(const fdt64_t *)p);
	return *lenp == 4 ? fdt32_to_cpu(*p) : 0;
}

/* called from last_stage_init once the console is on screen */
void tb_lk_info(void)
{
	void *fdt = (void *)tb_lk_fdt;
	const char *args;
	const fdt32_t *mem;
	u32 *bm;
	int off, len, i;
	u64 rs, re;

	if (!fdt || fdt_check_header(fdt)) {
		printf("tb7304x: no LK device tree (x0=%lx)\n", tb_lk_fdt);
		return;
	}
	env_set_hex("lkfdt", tb_lk_fdt);
	printf("tb7304x: LK DT at %lx, %u bytes\n", tb_lk_fdt, fdt_totalsize(fdt));
	off = fdt_path_offset(fdt, "/chosen");
	args = off < 0 ? NULL : fdt_getprop(fdt, off, "bootargs", NULL);
	printf("tb7304x: LK bootargs: %s\n", args ?: "(none)");
	rs = tb_prop_u(fdt, off, "linux,initrd-start", &len);
	re = tb_prop_u(fdt, off, "linux,initrd-end", &len);
	printf("tb7304x: LK initrd %llx-%llx (%d-byte cells)\n", rs, re, len);
	off = fdt_path_offset(fdt, "/memory");
	mem = off < 0 ? NULL : fdt_getprop(fdt, off, "reg", &len);
	printf("tb7304x: LK memory reg:");
	for (i = 0; mem && i < len / 4 && i < 16; i++)
		printf(" %08x", fdt32_to_cpu(mem[i]));
	printf("\n");

	bm = tb_bootmode(fdt);
	if (!bm) {
		printf("tb7304x: no atag,boot; assuming U-Boot is in boot, Android in recovery\n");
		env_set("android_part", "recovery");
		return;
	}
	env_set_ulong("lk_bootmode", le32_to_cpu(*bm));
	/* LK booted us as recovery: U-Boot lives in `recovery`, so Android is in `boot` (and vice versa) */
	env_set("android_part", le32_to_cpu(*bm) == LK_BOOTMODE_RECOVERY ? "boot" : "recovery");
	printf("tb7304x: LK bootmode %u, Android expected in '%s'\n", le32_to_cpu(*bm), env_get("android_part"));
}

static int tb_set_cell(void *fdt, int off, const char *name, u64 v)
{
	int len;

	if (!fdt_getprop(fdt, off, name, &len) || len == 8)
		return fdt_setprop_u64(fdt, off, name, v);
	return fdt_setprop_u32(fdt, off, name, (u32)v);
}

static bool tb_overlap(ulong a, ulong alen, ulong b, ulong blen)
{
	return a < b + blen && b < a + alen;
}

static int do_tbandroid(struct cmd_tbl *cmdtp, int flag, int argc, char *const argv[])
{
	ulong addr = argc > 1 ? hextoul(argv[1], NULL) : 0x50000000;
	struct andr_img_hdr *h = map_sysmem(addr, 0);
	void *fdt = (void *)tb_lk_fdt, *nfdt = (void *)TB_FDT_NEW;
	ulong ps, ksrc, rsrc, kaddr, raddr, rsize, total;
	unsigned long klen;
	int off, ret;
	u32 *bm;

	if (memcmp(h->magic, ANDR_BOOT_MAGIC, ANDR_BOOT_MAGIC_SIZE)) {
		printf("tbandroid: no Android boot image at %lx\n", addr);
		return CMD_RET_FAILURE;
	}
	if (!fdt || fdt_check_header(fdt)) {
		printf("tbandroid: no LK device tree\n");
		return CMD_RET_FAILURE;
	}
	ps = h->page_size;
	ksrc = addr + ps;
	rsrc = ksrc + ALIGN(h->kernel_size, ps);
	rsize = h->ramdisk_size;
	total = rsrc + ALIGN(rsize, ps) - addr;
	kaddr = h->kernel_addr;
	raddr = h->ramdisk_addr;
	printf("tbandroid: kernel %u @%lx, ramdisk %lu @%lx, cmdline '%s'\n", h->kernel_size, kaddr, rsize,
	       raddr, h->cmdline);

	/* everything is checked before the first write that cannot be undone (the ramdisk copy comes last) */
	if (kaddr < 0x40000000 || kaddr >= TB_KERNEL_LIMIT ||
	    tb_overlap(addr, total, kaddr, TB_KERNEL_LIMIT - kaddr) || tb_overlap(addr, total, raddr, rsize) ||
	    tb_overlap(raddr, rsize, kaddr, TB_KERNEL_LIMIT - kaddr) ||
	    tb_overlap(TB_FDT_NEW, fdt_totalsize(fdt) + TB_FDT_GROW, addr, total) ||
	    tb_overlap(TB_FDT_NEW, fdt_totalsize(fdt) + TB_FDT_GROW, raddr, rsize)) {
		printf("tbandroid: load ranges overlap, not booting\n");
		return CMD_RET_FAILURE;
	}

	ret = fdt_open_into(fdt, nfdt, fdt_totalsize(fdt) + TB_FDT_GROW);
	if (ret) {
		printf("tbandroid: fdt_open_into: %s\n", fdt_strerror(ret));
		return CMD_RET_FAILURE;
	}
	off = fdt_path_offset(nfdt, "/chosen");
	if (off < 0 || tb_set_cell(nfdt, off, "linux,initrd-start", raddr) ||
	    tb_set_cell(nfdt, off, "linux,initrd-end", raddr + rsize)) {
		printf("tbandroid: cannot set the initrd in /chosen\n");
		return CMD_RET_FAILURE;
	}
	bm = tb_bootmode(nfdt);
	if (bm && le32_to_cpu(*bm) == LK_BOOTMODE_RECOVERY) {
		*bm = cpu_to_le32(LK_BOOTMODE_NORMAL);
		printf("tbandroid: atag,boot bootmode recovery -> normal\n");
		/* LK also writes /firmware/android/mode (lk.bin 0x41e04848), which Android's init turns into
		 * ro.boot.mode; atag,boot alone is not enough (docs/mainline/research-lk-bootflow.md §3.7) */
		off = fdt_path_offset(nfdt, "/firmware/android");
		if (off >= 0 && fdt_setprop_string(nfdt, off, "mode", "normal") == 0)
			printf("tbandroid: /firmware/android/mode -> normal\n");
		else
			printf("tbandroid: no /firmware/android/mode to patch\n");
	}
	fdt_pack(nfdt);

	if (*(u8 *)ksrc == 0x1f && *(u8 *)(ksrc + 1) == 0x8b) {
		klen = h->kernel_size;	/* gzip stops at its trailer; LK's appended DTB after it is ignored */
		ret = gunzip((void *)kaddr, TB_KERNEL_LIMIT - kaddr, (uchar *)ksrc, &klen);
		if (ret) {
			printf("tbandroid: gunzip failed (%d)\n", ret);
			return CMD_RET_FAILURE;
		}
	} else {
		klen = h->kernel_size;
		memmove((void *)kaddr, (void *)ksrc, klen);
	}
	if (readl(kaddr + 56) != 0x644d5241) {	/* "ARM\x64" */
		printf("tbandroid: no arm64 Image at %lx\n", kaddr);
		return CMD_RET_FAILURE;
	}
	printf("tbandroid: Image %lu bytes, DT %u bytes at %lx\n", klen, fdt_totalsize(nfdt), TB_FDT_NEW);

	memmove((void *)raddr, (void *)rsrc, rsize);

	/* give the stock display driver the OVL state LK left (orange-state layer included) */
	if (tb_ovl_l0con)
		writel(tb_ovl_l0con, OVL0_L0_CON);
	if (tb_ovl_l3con)
		writel(tb_ovl_l3con, OVL0_L3_CON);

	printf("tbandroid: starting Android\n");
	dm_remove_devices_flags(DM_REMOVE_ACTIVE_ALL | DM_REMOVE_NON_VITAL);
	dm_remove_devices_flags(DM_REMOVE_ACTIVE_ALL);
	cleanup_before_linux();
	/* not at EL3 here (ATF entered U-Boot as it enters kernels), so this jumps straight to the kernel */
	armv8_switch_to_el2(TB_FDT_NEW, 0, 0, 0, kaddr, ES_TO_AARCH64);
	return CMD_RET_FAILURE;
}

U_BOOT_CMD(tbandroid, 2, 0, do_tbandroid,
	   "boot an Android boot image with LK's device tree",
	   "[addr]  - boot image in RAM (default 0x50000000)");

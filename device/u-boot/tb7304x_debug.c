// SPDX-License-Identifier: GPL-2.0
/*
 * TB-7304X bring-up: show U-Boot's progress on the panel. There is no UART on this tablet, but LK leaves the
 * panel lit and OVL0 scanning its framebuffer at 0x7f7b0000 (600x1024, 32 bpp, stride ~2432 bytes), so each
 * stage paints one white band (white is 0xffffffff in any 32-bit format). Bands from the top of the portrait
 * panel: 1 = board_early_init_f (before relocation), 2 = board_early_init_r (after relocation),
 * 3 = misc_init_r (devices up), 4 = last_stage_init (about to run the boot command).
 * A band near the bottom comes from tb7304x_entry.S (U-Boot's first instruction).
 * last_stage_init then puts a text console on the framebuffer and clears the screen, so the bands only stay
 * visible if U-Boot dies earlier or the video probe fails.
 */
#include <common.h>
#include <cpu_func.h>
#include <dm.h>
#include <init.h>
#include <video.h>
#include <env.h>
#include <console.h>
#include <asm/global_data.h>
#include <asm/io.h>

DECLARE_GLOBAL_DATA_PTR;

/* tb7304x_android.c */
extern u32 tb_ovl_l0con, tb_ovl_l3con;
void tb_lk_info(void);

#define TB_FB_BASE	0x7f7b0000UL
#define TB_FB_STRIDE	2432UL
#define TB_BAND_ROWS	96UL
#define TB_BAND_STEP	128UL

static void tb_band(unsigned int n)
{
	unsigned long start = TB_FB_BASE + (n - 1) * TB_BAND_STEP * TB_FB_STRIDE;
	unsigned long len = TB_BAND_ROWS * TB_FB_STRIDE;
	volatile u32 *p = (volatile u32 *)start;
	unsigned long i;

	for (i = 0; i < len / 4; i++)
		p[i] = 0xffffffff;
	/* no-op while the D-cache is off (before relocation) */
	flush_dcache_range(start, start + len);
}

int board_early_init_f(void)
{
	tb_band(1);
	return 0;
}

int board_early_init_r(void)
{
	tb_band(2);
	return 0;
}

int misc_init_r(void)
{
	tb_band(3);
	return 0;
}

/* thin full-width line = success */
static void tb_ok(unsigned int row)
{
	unsigned long start = TB_FB_BASE + row * TB_FB_STRIDE;
	unsigned long len = 8 * TB_FB_STRIDE;
	volatile u32 *p = (volatile u32 *)start;
	unsigned long i;

	for (i = 0; i < len / 4; i++)
		p[i] = 0xffffffff;
	flush_dcache_range(start, start + len);
}

/* n 16x16 squares, 24 per line = an errno to count */
static void tb_squares(unsigned int row, int n)
{
	int i, y, x;

	if (n > 48)
		n = 48;
	for (i = 0; i < n; i++) {
		unsigned int r = row + (i / 24) * 20, c = 8 + (i % 24) * 24;

		for (y = 0; y < 16; y++) {
			volatile u32 *p = (volatile u32 *)(TB_FB_BASE + (r + y) * TB_FB_STRIDE + c * 4);

			for (x = 0; x < 16; x++)
				p[x] = 0xffffffff;
		}
	}
	flush_dcache_range(TB_FB_BASE + row * TB_FB_STRIDE, TB_FB_BASE + (row + 40) * TB_FB_STRIDE);
}

static void tb_report(unsigned int row, int ret)
{
	if (ret)
		tb_squares(row, ret < 0 ? -ret : ret);
	else
		tb_ok(row);
}

/* LK's display pipe: OVL0 (0x14007000) layer 0 scans the framebuffer, layer 3 holds the "orange state" text */
#define OVL0_SRC_CON	0x1400702c
#define OVL0_L0_CON	0x14007030
#define OVL0_L0_PITCH	0x14007044
#define OVL0_L3_CON	0x14007090
#define OVL0_L0_ADDR	0x14007f40

/*
 * Display hand-over from LK, worked out over runs 1-5 (photos of the panel):
 *  - OVL0 SRC_CON=0x9: layer 0 (our framebuffer, 0x7f7b0000, pitch 0x980) and layer 3 (LK's "orange state"
 *    text) are on. Both have L_CON=0x21ff: format 2 (matches U-Boot's x8r8g8b8) with AEN (bit 8) set, so
 *    U-Boot's 0x00rrggbb pixels were transparent and LK's picture showed through. Clear AEN on L0 (opaque) and
 *    set L3's constant alpha to 0 (disabling the layer in SRC_CON stalls OVL).
 *  - This U-Boot tree comments console_init_r out of board_r.c ("HACK: disable console_init_r",
 *    25b8cdd6e7), so GD_FLG_DEVINIT is never set and every printf went to the unwired UART only. Run it here,
 *    once the video console exists, with stdin = nulldev (no phantom UART input) and output on both.
 */
int last_stage_init(void)
{
	u32 src = readl(OVL0_SRC_CON), l0con = readl(OVL0_L0_CON), l3con = readl(OVL0_L3_CON);
	struct udevice *dev;
	int vret, uret, cret;

	tb_ovl_l0con = l0con;
	tb_ovl_l3con = l3con;
	if (src & BIT(3))
		writel(l3con & ~0xffU, OVL0_L3_CON);
	writel(l0con & ~BIT(8), OVL0_L0_CON);

	vret = uclass_first_device_err(UCLASS_VIDEO, &dev);
	if (vret) {
		/* no console: fall back to the band markers */
		tb_band(4);
		tb_report(104, vret);
		return 0;
	}
	video_clear(dev);

	/*
	 * bootm moves the DTB and initrd to the top of RAM by default, inside the no-map region at 0x78000000
	 * (mt6735.dtsi): Linux then fails to reserve it and puts CMA there. Keep them low, as LK does.
	 */
	env_set("fdt_high", "0x4c000000");
	env_set("initrd_high", "0x4c000000");

	env_set("stdin", "nulldev");
	env_set("stdout", "serial,vidconsole");
	env_set("stderr", "serial,vidconsole");
	cret = console_init_r();

	uret = uclass_get_device(UCLASS_USB_GADGET_GENERIC, 0, &dev);
	printf("tb7304x: console_init_r %d, DEVINIT %d\n", cret, !!(gd->flags & GD_FLG_DEVINIT));
	printf("tb7304x: OVL0 SRC %08x L0 %08x->%08x L3 %08x->%08x\n", src, l0con, readl(OVL0_L0_CON),
	       l3con, readl(OVL0_L3_CON));
	printf("tb7304x: usb gadget probe %d\n", uret);
	tb_lk_info();
	return 0;
}

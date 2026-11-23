// SPDX-License-Identifier: GPL-2.0
/*
 * mtk-lk-fb: register a "simple-framebuffer" for the display MediaTek LK
 * left running (MT6735/MT6737 family), so simpledrm + fbcon can draw on it
 * without a real DSI/panel driver.
 *
 * Sources of truth, in order:
 *   1. module params (lkfb.addr=, lkfb.stride=, lkfb.format=, ...) on the cmdline
 *   2. the OVL0 layer registers (what the hardware is actually scanning out)
 *   3. /chosen "atag,videolfb" written by LK (fb_base, islcmfound, fps, vram, lcmname)
 *
 * Reading OVL registers assumes LK left the display powered/clocked (it
 * shows the boot logo / "orange state" screen). Pass lkfb.ovl=0 to skip.
 */
#include <linux/init.h>
#include <linux/io.h>
#include <linux/kernel.h>
#include <linux/moduleparam.h>
#include <linux/of.h>
#include <linux/of_address.h>
#include <linux/platform_data/simplefb.h>
#include <linux/platform_device.h>
#include <linux/unaligned.h>

#undef MODULE_PARAM_PREFIX
#define MODULE_PARAM_PREFIX "lkfb."

static bool enable = true;
module_param(enable, bool, 0444);
static bool ovl = true;
module_param(ovl, bool, 0444);
static ulong addr;
module_param(addr, ulong, 0444);
static uint width;	/* 0 = from OVL, else 600 */
module_param(width, uint, 0444);
static uint height;	/* 0 = from OVL, else 1024 */
module_param(height, uint, 0444);
static uint stride;
module_param(stride, uint, 0444);
static char *format;
module_param(format, charp, 0444);

#define OVL0_BASE		0x14007000
#define OVL_SRC_CON		0x002c
#define OVL_CON(n)		(0x0030 + 0x20 * (n))
#define OVL_SRC_SIZE(n)		(0x0038 + 0x20 * (n))
#define OVL_PITCH(n)		(0x0044 + 0x20 * (n))
#define OVL_ADDR(n)		(0x0f40 + 0x20 * (n))
#define OVL_CON_BYTE_SWAP	BIT(24)

static struct simplefb_platform_data pdata;

static const char *ovl_fmt(u32 con, unsigned int *bpp)
{
	bool swap = con & OVL_CON_BYTE_SWAP;

	switch ((con >> 12) & 0xf) {
	case 0: *bpp = 2; return swap ? "r5g6b5" /* BGR565: no simplefb name */ : "r5g6b5";
	case 1: *bpp = 3; return swap ? "b8g8r8" : "r8g8b8";
	case 2: *bpp = 4; return swap ? "x8b8g8r8" : "x8r8g8b8";
	case 3: *bpp = 4; return "x8r8g8b8"; /* RGBA8888: no simplefb name, colours may be off */
	default: *bpp = 4; return "x8r8g8b8";
	}
}

static int __init mtk_lk_fb_init(void)
{
	struct platform_device *pdev;
	struct resource res = { .flags = IORESOURCE_MEM };
	const char *fmt = "x8r8g8b8";
	unsigned int bpp = 4;
	u64 fb_base = 0, ovl_addr = 0;
	u32 vram = 0, ovl_pitch = 0;
	const u8 *tag;
	int len, n;

	if (!enable)
		return 0;
	if (!of_machine_is_compatible("mediatek,mt6735"))
		return 0;

	tag = of_get_property(of_chosen, "atag,videolfb", &len);
	if (tag && len >= 20) {
		fb_base = get_unaligned_le64(tag);
		vram = get_unaligned_le32(tag + 16);
		pr_info("lkfb: atag,videolfb len=%d fb_base=0x%llx islcmfound=%u fps=%u vram=0x%x lcm=%.*s\n",
			len, fb_base, get_unaligned_le32(tag + 8),
			get_unaligned_le32(tag + 12), vram,
			len > 20 ? len - 20 : 0, len > 20 ? (const char *)tag + 20 : "");
		print_hex_dump(KERN_INFO, "lkfb: tag ", DUMP_PREFIX_OFFSET, 16, 4,
			       tag, min(len, 64), false);
	} else {
		pr_warn("lkfb: no atag,videolfb in /chosen\n");
	}

	if (ovl) {
		void __iomem *base = ioremap(OVL0_BASE, 0x1000);

		if (base) {
			u32 src = readl(base + OVL_SRC_CON);

			pr_info("lkfb: OVL0 SRC_CON=0x%08x\n", src);
			for (n = 0; n < 4; n++) {
				u32 con = readl(base + OVL_CON(n));
				u32 size = readl(base + OVL_SRC_SIZE(n));
				u32 pitch = readl(base + OVL_PITCH(n));
				u32 a = readl(base + OVL_ADDR(n));

				pr_info("lkfb: OVL0 L%d en=%d con=0x%08x size=%ux%u pitch=0x%08x addr=0x%08x\n",
					n, !!(src & BIT(n)), con, size & 0xfff,
					(size >> 16) & 0xfff, pitch, a);
				if (!ovl_addr && (src & BIT(n)) && a) {
					ovl_addr = a;
					ovl_pitch = pitch & 0xffff;
					fmt = ovl_fmt(con, &bpp);
					if (!width && !height && (size & 0xfff) &&
					    ((size >> 16) & 0xfff)) {
						width = size & 0xfff;
						height = (size >> 16) & 0xfff;
					}
				}
			}
			iounmap(base);
		}
	}

	if (addr) {
		res.start = addr;
	} else if (ovl_addr) {
		res.start = ovl_addr;
	} else if (fb_base) {
		res.start = fb_base;
	} else {
		pr_err("lkfb: no framebuffer address found, giving up\n");
		return -ENODEV;
	}

	if (!width)
		width = 600;
	if (!height)
		height = 1024;
	pdata.width = width;
	pdata.height = height;
	pdata.stride = stride ? stride : (ovl_pitch ? ovl_pitch : ALIGN(width, 32) * bpp);
	pdata.format = format ? format : fmt;
	res.end = res.start + (resource_size_t)pdata.stride * height - 1;

	pr_info("lkfb: registering simple-framebuffer @0x%llx %ux%u stride=%u fmt=%s\n",
		(u64)res.start, pdata.width, pdata.height, pdata.stride, pdata.format);

	/* The real display driver (mediatek-drm on DSI0) owns the panel: LK's framebuffer will not be scanned. */
	{
		struct device_node *np = of_find_compatible_node(NULL, NULL, "mediatek,mt6735-dsi");
		bool dsi = np && of_device_is_available(np);

		of_node_put(np);
		if (dsi) {
			pr_info("lkfb: DSI0 is enabled in DT (mediatek-drm drives the panel), not registering\n");
			return 0;
		}
	}

	/*
	 * A DT simple-framebuffer (with power-domains/clocks so the display stays powered once the SMI larbs and
	 * IOMMU manage runtime PM) takes precedence: then only check that it matches what LK reports.
	 */
	{
		struct device_node *np = of_find_compatible_node(NULL, NULL, "simple-framebuffer");
		struct resource dtres;

		if (np && of_device_is_available(np)) {
			if (!of_address_to_resource(np, 0, &dtres) && dtres.start != res.start)
				pr_warn("lkfb: DT simple-framebuffer at %pa but LK scans out 0x%llx: DT node is stale!\n",
					&dtres.start, (u64)res.start);
			pr_info("lkfb: DT simple-framebuffer present (%pOF), not registering another\n", np);
			of_node_put(np);
			return 0;
		}
		of_node_put(np);
	}

	pdev = platform_device_register_resndata(NULL, "simple-framebuffer", 0,
						 &res, 1, &pdata, sizeof(pdata));
	return PTR_ERR_OR_ZERO(pdev);
}
/* before simpledrm's module_init-level driver registration is fine either way */
device_initcall(mtk_lk_fb_init);

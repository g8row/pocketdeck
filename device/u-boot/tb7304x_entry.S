/* SPDX-License-Identifier: GPL-2.0 */
/*
 * TB-7304X bring-up: the very first code U-Boot runs after LK's jump (start.S `reset` -> save_boot_params,
 * MMU and caches off). Paints a white band near the BOTTOM of LK's framebuffer (rows 896..991 at stride 2432),
 * so "bottom band but no top bands" means U-Boot was entered but died before board_early_init_f.
 * Saves x0 (LK's DTB) in tb_lk_fdt. Uses only x9-x11; x0-x3 (LK's arguments) are untouched.
 */
#include <linux/linkage.h>

ENTRY(save_boot_params)
	/* x0 = the DTB LK patched for us (tb7304x_android.c); .data is plain RAM at this point */
	adrp	x9, tb_lk_fdt
	add	x9, x9, :lo12:tb_lk_fdt
	str	x0, [x9]
	ldr	x9, =(0x7f7b0000 + 896 * 2432)
	ldr	x10, =(96 * 2432)
	mov	w11, #0xffffffff
1:	str	w11, [x9], #4
	subs	x10, x10, #4
	b.ne	1b
	dsb	sy
	b	save_boot_params_ret
ENDPROC(save_boot_params)

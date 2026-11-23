// SPDX-License-Identifier: GPL-2.0
/*
 * bootmenu: the TB-7304X stage-1 boot chooser (docs/mainline/plan-dualboot.md §5).
 *
 *   bootmenu <seconds> [status line]
 *
 * Draws a menu on /dev/fb0 and returns the choice as the exit status; stage 1 (init) performs it:
 *   0 Linux (continue this boot)   1 Android (normal mode, via U-Boot)   2 Android without U-Boot (LK directly)
 *   3 Rescue shell (stay in the initramfs)   4 U-Boot fastboot   5 LK fastboot
 * Input: double-tap a row (two taps within 1.5 s), or Vol+/Vol- to move and Power to select. The countdown (default choice: Linux) stops at the
 * first input; after 30 s without input it continues with Linux anyway. Every failure (no framebuffer within 4 s,
 * a crash, a signal) ends in exit status 0, i.e. "continue Linux": the menu can never block or redirect a boot by
 * itself. Kernel messages are kept off the screen with KD_GRAPHICS on tty0 while it runs.
 *
 * Font: Terminus 16x32 from the kernel tree (lib/fonts/font_ter16x32.c), converted at build time to font.h.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <linux/kd.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include "font.h"	/* static const unsigned char font_ter16x32[16384]; */

#define FW 16
#define FH 32
#define NITEMS 6
#define IDLE_MS 30000

static const char *const items[NITEMS] = {
	"Linux", "Android", "Android without U-Boot", "Rescue shell", "U-Boot fastboot", "LK fastboot",
};

static uint8_t *fb;
static unsigned int W, H, stride, bpp;
static struct fb_var_screeninfo vi;
static int tty = -1;

static uint32_t rgb(unsigned r, unsigned g, unsigned b)
{
	return (r >> (8 - vi.red.length)) << vi.red.offset | (g >> (8 - vi.green.length)) << vi.green.offset |
	       (b >> (8 - vi.blue.length)) << vi.blue.offset;
}

static void px(unsigned x, unsigned y, uint32_t c)
{
	if (x < W && y < H) {
		if (bpp == 32)
			*(uint32_t *)(fb + y * stride + x * 4) = c;
		else
			*(uint16_t *)(fb + y * stride + x * 2) = c;
	}
}

static void rect(unsigned x, unsigned y, unsigned w, unsigned h, uint32_t c)
{
	unsigned i, j;

	for (j = y; j < y + h && j < H; j++)
		for (i = x; i < x + w && i < W; i++)
			px(i, j, c);
}

/* text at (x, y), integer scale; returns the x after the last glyph */
static unsigned text(unsigned x, unsigned y, const char *s, unsigned sc, uint32_t c)
{
	unsigned r, col, a, b;

	for (; *s; s++, x += FW * sc) {
		const unsigned char *g = font_ter16x32 + (unsigned char)*s * FH * 2;

		for (r = 0; r < FH; r++)
			for (col = 0; col < FW; col++)
				if (g[r * 2 + col / 8] & (0x80 >> (col % 8)))
					for (a = 0; a < sc; a++)
						for (b = 0; b < sc; b++)
							px(x + col * sc + b, y + r * sc + a, c);
	}
	return x;
}

static unsigned row_y(int i) { return 200 + i * 112; }

static void draw(int sel, int countdown, const char *status)
{
	uint32_t bg = rgb(16, 20, 24), fg = rgb(230, 230, 230), dim = rgb(140, 150, 160);
	uint32_t hl = rgb(40, 110, 200), box = rgb(36, 42, 50);
	char buf[64];
	int i;

	rect(0, 0, W, H, bg);
	text(24, 48, "TB-7304X", 2, fg);
	text(24, 128, "Boot", 1, dim);
	for (i = 0; i < NITEMS; i++) {
		rect(16, row_y(i), W - 32, 96, i == sel ? hl : box);
		text(40, row_y(i) + 32, items[i], 1, fg);
		if (i == 0 && countdown >= 0) {
			snprintf(buf, sizeof(buf), "%d", countdown);
			text(W - 40 - FW * strlen(buf), row_y(i) + 32, buf, 1, fg);
		}
	}
	text(24, H - 120, "Double-tap, or Vol+/- and Power", 1, dim);
	if (status) {
		snprintf(buf, sizeof(buf), "%.35s", status);
		text(24, H - 64, buf, 1, dim);
	}
	msync(fb, stride * H, MS_ASYNC);
}

static void restore(void)
{
	if (tty >= 0) {
		ioctl(tty, KDSETMODE, KD_TEXT);
		close(tty);
		tty = -1;
	}
}

static void on_signal(int s)
{
	(void)s;
	restore();
	_exit(0);
}

static long now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1000L + t.tv_nsec / 1000000;
}

struct in { int fd, touch; int xmin, xmax, ymin, ymax; };

static long t_start;

/* every input and decision goes to stderr (init: /www/menu.log, copied into the stage-1 log) */
static void lg(const char *what, int a, int b)
{
	fprintf(stderr, "bootmenu +%ldms %s %d %d\n", now_ms() - t_start, what, a, b);
}

int main(int argc, char **argv)
{
	struct fb_fix_screeninfo fi;
	struct in in[8];
	struct pollfd pf[8];
	int n = 0, i, fd = -1, sel = 0, secs = argc > 1 ? atoi(argv[1]) : 3, countdown, down = 0, tx = -1, ty = -1;
	int px0 = -1, py0 = -1;
	long tdown = 0, thl = -100000;
	const char *status = argc > 2 ? argv[2] : NULL;
	long t0, deadline, last;
	DIR *d;
	struct dirent *e;

	signal(SIGTERM, on_signal);
	signal(SIGINT, on_signal);
	signal(SIGSEGV, on_signal);
	if (secs <= 0)
		return 0;
	for (i = 0; i < 40 && fd < 0; i++) {	/* mediatek-drm registers fb0 ~0.6 s after init starts */
		fd = open("/dev/fb0", O_RDWR);
		if (fd < 0)
			usleep(100000);
	}
	if (fd < 0 || ioctl(fd, FBIOGET_VSCREENINFO, &vi) || ioctl(fd, FBIOGET_FSCREENINFO, &fi))
		return 0;
	W = vi.xres; H = vi.yres; stride = fi.line_length; bpp = vi.bits_per_pixel;
	if ((bpp != 32 && bpp != 16) || W < 400 || H < 900)
		return 0;
	fb = mmap(NULL, stride * H, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (fb == MAP_FAILED)
		return 0;

	d = opendir("/dev/input");
	while (d && (e = readdir(d)) && n < 8) {
		char p[300];
		struct input_absinfo ax, ay;
		unsigned long absbits = 0;

		if (strncmp(e->d_name, "event", 5))
			continue;
		snprintf(p, sizeof(p), "/dev/input/%s", e->d_name);
		in[n].fd = open(p, O_RDONLY | O_NONBLOCK);
		if (in[n].fd < 0)
			continue;
		ioctl(in[n].fd, EVIOCGBIT(EV_ABS, sizeof(absbits)), &absbits);
		in[n].touch = 0;
		if (!ioctl(in[n].fd, EVIOCGABS(ABS_MT_POSITION_X), &ax) && !ioctl(in[n].fd, EVIOCGABS(ABS_MT_POSITION_Y), &ay)
		    && ax.maximum > 0) {
			in[n].touch = 1;
		} else if ((absbits & (1UL << ABS_X)) && !ioctl(in[n].fd, EVIOCGABS(ABS_X), &ax) &&
			   !ioctl(in[n].fd, EVIOCGABS(ABS_Y), &ay) && ax.maximum > 0) {
			in[n].touch = 2;
		}
		if (in[n].touch) {
			in[n].xmin = ax.minimum; in[n].xmax = ax.maximum;
			in[n].ymin = ay.minimum; in[n].ymax = ay.maximum;
		}
		pf[n].fd = in[n].fd;
		pf[n].events = POLLIN;
		n++;
	}
	if (d)
		closedir(d);

	tty = open("/dev/tty0", O_RDWR);
	if (tty >= 0)
		ioctl(tty, KDSETMODE, KD_GRAPHICS);

	t0 = last = t_start = now_ms();
	lg("start, inputs/countdown", n, secs);
	deadline = t0 + secs * 1000L;
	countdown = secs;
	draw(sel, countdown, status);
	for (;;) {
		long t = now_ms();
		int choose = -1;

		if (countdown >= 0) {
			int left = (int)((deadline - t + 999) / 1000);

			if (t >= deadline) {
				lg("countdown over: linux", 0, 0);
				choose = 0;
			} else if (left != countdown) {
				countdown = left;
				draw(sel, countdown, status);
			}
		} else if (t - last >= IDLE_MS) {
			lg("idle: linux", 0, 0);
			choose = 0;
		}
		if (choose >= 0) {
			restore();
			return choose;
		}
		if (poll(pf, n, 100) <= 0)
			continue;
		for (i = 0; i < n; i++) {
			struct input_event ev;

			if (!(pf[i].revents & POLLIN))
				continue;
			while (read(in[i].fd, &ev, sizeof(ev)) == sizeof(ev)) {
				int moved = 0, rowh;

				if (ev.type == EV_KEY && ev.value == 1 && ev.code == KEY_VOLUMEUP) {
					sel = (sel + NITEMS - 1) % NITEMS; moved = 1;
					lg("vol+ -> row", sel, 0);
				} else if (ev.type == EV_KEY && ev.value == 1 && ev.code == KEY_VOLUMEDOWN) {
					sel = (sel + 1) % NITEMS; moved = 1;
					lg("vol- -> row", sel, 0);
				} else if (ev.type == EV_KEY && ev.value == 1 && ev.code == KEY_POWER) {
					choose = sel;
					lg("power: choose row", sel, 0);
				} else if (in[i].touch && ev.type == EV_ABS &&
					   (ev.code == ABS_MT_POSITION_X || ev.code == ABS_X)) {
					tx = (long)(ev.value - in[i].xmin) * W / (in[i].xmax - in[i].xmin + 1);
					if (down && px0 < 0)
						px0 = tx;
				} else if (in[i].touch && ev.type == EV_ABS &&
					   (ev.code == ABS_MT_POSITION_Y || ev.code == ABS_Y)) {
					ty = (long)(ev.value - in[i].ymin) * H / (in[i].ymax - in[i].ymin + 1);
					if (down && py0 < 0)
						py0 = ty;
				} else if (in[i].touch && ev.type == EV_KEY && ev.code == BTN_TOUCH) {
					if (ev.value == 1) {
						down = 1; tdown = now_ms(); px0 = py0 = -1;
					} else if (down) {
						/* a tap: short (< 0.8 s), not a slide (< 40 px), began after start. A tap highlights
						 * its row, a second tap on it within 1.5 s chooses it (or Power): a thumb holding the
						 * tablet or a ghost touch cannot start anything by itself. */
						int dur = (int)(now_ms() - tdown), r = -1;

						down = 0;
						if (px0 < 0) { px0 = tx; py0 = ty; }
						for (rowh = 0; rowh < NITEMS; rowh++)
							if (ty >= (int)row_y(rowh) && ty < (int)row_y(rowh) + 96 && tx >= 16 &&
							    tx < (int)W - 16)
								r = rowh;
						lg("touch release x", tx, ty);
						lg("  row, duration ms", r, dur);
						if (r >= 0 && dur < 800 && abs(tx - px0) < 40 && abs(ty - py0) < 40) {
							/* choose only on a double tap: the same row again within 1.5 s. The cracked
							 * glass produces ghost touches at a fixed spot every few seconds (>= 2.5 s
							 * apart, measured 2026-11-17), which can never confirm anything. */
							if (r == sel && now_ms() - thl < 1500) {
								choose = r;
								lg("double tap: choose", r, 0);
							} else {
								sel = r;
								thl = now_ms();
								lg("tap: highlight row", r, 0);
							}
							moved = 1;
						} else {
							/* not a tap on a row: no effect at all, not even on the countdown or the
							 * idle timer (a thumb holding the tablet, or a ghost touch, must not keep
							 * the menu up) */
							lg("not a tap, ignored", r, dur);
						}
					}
				}
				if (moved || choose >= 0) {
					countdown = -1;
					last = now_ms();
					if (choose < 0)
						draw(sel, countdown, status);
				}
			}
		}
		if (choose >= 0) {
			if (choose != sel) {
				sel = choose;
				draw(sel, -1, status);
			}
			usleep(150000);	/* show the selection before the screen changes */
			restore();
			return choose;
		}
	}
}

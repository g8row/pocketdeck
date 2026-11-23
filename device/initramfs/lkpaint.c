/*
 * lkpaint — fill the screen with one colour, as a "sign of life" test.
 *
 *   lkpaint fb  RRGGBB            fill /dev/fb0 (simpledrm / mtkfb)
 *   lkpaint mem RRGGBB [addr size] fill physical memory via /dev/mem; default
 *                                 addr/size = fb_base/vram from
 *                                 /proc/device-tree/chosen/atag,videolfb (MTK LK)
 *   lkpaint info                  print what atag,videolfb says
 *
 * Static, no libc beyond the basics. GPL-2.0.
 */
#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

static int read_tag(uint64_t *base, uint32_t *vram, char *name, size_t nlen)
{
	unsigned char buf[256];
	int fd = open("/proc/device-tree/chosen/atag,videolfb", O_RDONLY);
	ssize_t n;

	if (fd < 0)
		return -1;
	n = read(fd, buf, sizeof(buf) - 1);
	close(fd);
	if (n < 20)
		return -1;
	*base = 0;
	for (int i = 7; i >= 0; i--)
		*base = (*base << 8) | buf[i];
	*vram = buf[16] | buf[17] << 8 | buf[18] << 16 | (uint32_t)buf[19] << 24;
	buf[n] = 0;
	snprintf(name, nlen, "%.*s", (int)nlen - 1, (char *)buf + 20);
	return 0;
}

static void fill32(volatile uint32_t *p, size_t words, uint32_t v)
{
	for (size_t i = 0; i < words; i++)
		p[i] = v;
}

static int paint_fb(uint32_t rgb)
{
	struct fb_var_screeninfo v;
	struct fb_fix_screeninfo f;
	int fd = open("/dev/fb0", O_RDWR);
	uint8_t *p;
	size_t len;

	if (fd < 0) { perror("open /dev/fb0"); return 1; }
	if (ioctl(fd, FBIOGET_VSCREENINFO, &v) || ioctl(fd, FBIOGET_FSCREENINFO, &f)) {
		perror("FBIOGET"); return 1;
	}
	printf("fb0: %s %ux%u bpp=%u line=%u smem=0x%lx len=%u\n", f.id, v.xres, v.yres,
	       v.bits_per_pixel, f.line_length, f.smem_start, f.smem_len);
	len = f.smem_len ? f.smem_len : (size_t)f.line_length * v.yres_virtual;
	p = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (p == MAP_FAILED) { perror("mmap fb0"); return 1; }
	uint32_t r = rgb >> 16 & 0xff, g = rgb >> 8 & 0xff, b = rgb & 0xff;
	if (v.bits_per_pixel == 16) {
		uint16_t px = (r >> 3) << 11 | (g >> 2) << 5 | (b >> 3);
		for (size_t i = 0; i < len / 2; i++)
			((volatile uint16_t *)p)[i] = px;
	} else if (v.bits_per_pixel == 32) {
		uint32_t px = 0xff000000u | r << v.red.offset | g << v.green.offset | b << v.blue.offset;
		fill32((volatile uint32_t *)p, len / 4, px);
	} else {
		for (size_t i = 0; i + 2 < len; i += 3) { p[i] = b; p[i + 1] = g; p[i + 2] = r; }
	}
	munmap(p, len);
	close(fd);
	return 0;
}

static int paint_mem(uint32_t rgb, uint64_t addr, size_t size)
{
	long pg = sysconf(_SC_PAGESIZE);
	int fd = open("/dev/mem", O_RDWR | O_SYNC);
	void *p;

	if (fd < 0) { perror("open /dev/mem"); return 1; }
	size = (size + pg - 1) & ~(size_t)(pg - 1);
	p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, (off_t)addr);
	if (p == MAP_FAILED) { perror("mmap /dev/mem"); return 1; }
	printf("mem: painting 0x%llx + 0x%zx with 0x%06x (as xRGB8888)\n",
	       (unsigned long long)addr, size, rgb);
	fill32(p, size / 4, 0xff000000u | rgb);
	msync(p, size, MS_SYNC);
	munmap(p, size);
	close(fd);
	return 0;
}

int main(int argc, char **argv)
{
	uint64_t base = 0;
	uint32_t vram = 0;
	char name[128] = "";
	int have = read_tag(&base, &vram, name, sizeof(name)) == 0;

	if (argc >= 2 && !strcmp(argv[1], "info")) {
		if (!have) { puts("no atag,videolfb"); return 1; }
		printf("fb_base=0x%llx vram=0x%x lcm=%s\n", (unsigned long long)base, vram, name);
		return 0;
	}
	if (argc < 3) {
		fprintf(stderr, "usage: lkpaint fb|mem RRGGBB [addr size] | lkpaint info\n");
		return 2;
	}
	uint32_t rgb = strtoul(argv[2], NULL, 16);
	if (!strcmp(argv[1], "fb"))
		return paint_fb(rgb);
	if (!strcmp(argv[1], "mem")) {
		if (argc >= 5)
			return paint_mem(rgb, strtoull(argv[3], NULL, 0), strtoul(argv[4], NULL, 0));
		if (!have) { fputs("no atag,videolfb; pass addr size\n", stderr); return 1; }
		if (!vram)
			vram = 608 * 1024 * 4 * 3;
		return paint_mem(rgb, base, vram);
	}
	return 2;
}

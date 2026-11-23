// SPDX-License-Identifier: GPL-2.0
/*
 * tbstate: read/write the TB-7304X boot record from Linux (stage 1 and 2) and from Android (root).
 * Format and location: mainline/u-boot/tbstate.h; design: docs/mainline/plan-dualboot.md §4.
 *
 *   tbstate [show]                 print the record as key=value lines (state=ok|blank|corrupt first)
 *   tbstate set key=value ...      default=linux|android  oneshot=none|linux|android|fastboot  attempts=<n>
 *                                  max=<n>  stage=<name>  error=<name>  slot=cache|a|b
 *   tbstate stage <name>           last_stage = none|uboot|kernel|init|healthy
 *   tbstate healthy                attempts=0, last_stage=healthy, last_error=none, last_good_slot = the slot
 *                                  this kernel was booted from (tb.slot= on /proc/cmdline) (stage 2, after 60 s)
 *
 * The partition is found by GPT name in /sys/class/block (works in the initramfs, Alpine and Android). Writes
 * go over the older copy with O_DIRECT|O_SYNC and are read back. Nothing is written unless the partition is the
 * 1 MiB `tbstate` one (TBS_PART_MIN/MAX_SECTORS), and only the two record sectors are ever written.
 * Static build, no libc extras: aarch64-linux-gnu-gcc -static -O2 -I mainline/u-boot -o tbstate tbstate.c
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "tbstate.h"

static unsigned int crc32_z(const unsigned char *p, size_t n)
{
	unsigned int c = 0xffffffff;
	int k;

	while (n--) {
		c ^= *p++;
		for (k = 0; k < 8; k++)
			c = c & 1 ? (c >> 1) ^ 0xedb88320 : c >> 1;
	}
	return ~c;
}

static unsigned int tbs_crc(const struct tbstate *s)
{
	struct tbstate t = *s;

	t.crc = 0;
	return crc32_z((const unsigned char *)&t, sizeof(t));
}

static int tbs_valid(const struct tbstate *s)
{
	return s->magic == TBS_MAGIC && s->version == TBS_VERSION && s->crc == tbs_crc(s);
}

/* /sys/class/block/<x>/uevent has PARTNAME=<name>; the node is /dev/<x> or /dev/block/<x> (Android) */
static int find_part(char *dev, size_t len, unsigned long long *sectors)
{
	DIR *d = opendir("/sys/class/block");
	struct dirent *e;
	char p[300], buf[512];
	int found = 0;

	if (!d)
		return -1;
	while (!found && (e = readdir(d))) {
		FILE *f;

		snprintf(p, sizeof(p), "/sys/class/block/%s/uevent", e->d_name);
		f = fopen(p, "r");
		if (!f)
			continue;
		while (fgets(buf, sizeof(buf), f))
			if (!strcmp(buf, "PARTNAME=" TBS_PART "\n"))
				found = 1;
		fclose(f);
		if (!found)
			continue;
		snprintf(p, sizeof(p), "/sys/class/block/%s/size", e->d_name);
		f = fopen(p, "r");
		if (!f || fscanf(f, "%llu", sectors) != 1)
			found = 0;
		if (f)
			fclose(f);
		snprintf(dev, len, "/dev/block/%s", e->d_name);
		if (access(dev, F_OK))
			snprintf(dev, len, "/dev/%s", e->d_name);
	}
	closedir(d);
	return found ? 0 : -1;
}

static struct tbstate *blk;	/* 2 aligned blocks for O_DIRECT */
static const char *state = "?";
static struct tbstate cur;
static char dev[300];

static int rw(int fd, int write, int copy, struct tbstate *b)
{
	off_t off = ((off_t)TBS_AREA_SECTOR + copy * TBS_COPY_STRIDE) * 512;
	ssize_t r = write ? pwrite(fd, b, 512, off) : pread(fd, b, 512, off);

	return r == 512 ? 0 : -1;
}

static int load(int fd)
{
	int i, best = -1, magic = 0;

	for (i = 0; i < 2; i++) {
		if (rw(fd, 0, i, &blk[i]))
			memset(&blk[i], 0, 512);
		magic |= blk[i].magic == TBS_MAGIC;
		if (tbs_valid(&blk[i]) && (best < 0 || blk[i].generation > blk[best].generation))
			best = i;
	}
	if (best >= 0) {
		cur = blk[best];
		state = "ok";
	} else {
		memset(&cur, 0, sizeof(cur));
		cur.magic = TBS_MAGIC;
		cur.version = TBS_VERSION;
		cur.default_target = TBS_T_LINUX;
		cur.max_attempts = 3;
		state = magic ? "corrupt" : "blank";
	}
	return 0;
}

static int save(int fd)
{
	int copy;

	cur.generation++;
	cur.crc = tbs_crc(&cur);
	copy = cur.generation & 1;
	blk[0] = cur;
	if (rw(fd, 1, copy, &blk[0]) || fsync(fd) || rw(fd, 0, copy, &blk[1]) || memcmp(&blk[0], &blk[1], 512)) {
		fprintf(stderr, "tbstate: write of generation %u failed: %s\n", cur.generation, strerror(errno));
		return -1;
	}
	state = "ok";
	return 0;
}

static int lookup(const char *const *names, int n, const char *s)
{
	int i;

	for (i = 0; i < n; i++)
		if (!strcmp(names[i], s))
			return i;
	return -1;
}

static const char *name(const char *const *names, int n, unsigned int v)
{
	return v < (unsigned int)n ? names[v] : "?";
}

static void show(void)
{
	printf("state=%s\ndevice=%s\ngeneration=%u\ndefault=%s\noneshot=%s\nattempts=%u\nmax=%u\nstage=%s\n"
	       "error=%s\nslot=%s\nlast_good_slot=%s\nlinux_boots=%u\nfallbacks=%u\n", state, dev, cur.generation,
	       name(tbs_target_name, 4, cur.default_target), name(tbs_target_name, 4, cur.oneshot), cur.attempts,
	       cur.max_attempts, name(tbs_stage_name, 5, cur.last_stage), name(tbs_error_name, 5, cur.last_error),
	       name(tbs_slot_name, 3, cur.slot), name(tbs_slot_name, 3, cur.last_good_slot), cur.linux_boots,
	       cur.fallbacks);
}

static int set(const char *kv)
{
	const char *v = strchr(kv, '=');
	size_t k = v ? (size_t)(v - kv) : 0;
	int n;

	if (!v)
		return -1;
	v++;
	if (k == 7 && !strncmp(kv, "default", 7)) {
		n = lookup(tbs_target_name, 4, v);
		if (n != TBS_T_LINUX && n != TBS_T_ANDROID)
			return -1;
		cur.default_target = n;
	} else if (k == 7 && !strncmp(kv, "oneshot", 7)) {
		if ((n = lookup(tbs_target_name, 4, v)) < 0)
			return -1;
		cur.oneshot = n;
	} else if (k == 5 && !strncmp(kv, "stage", 5)) {
		if ((n = lookup(tbs_stage_name, 5, v)) < 0)
			return -1;
		cur.last_stage = n;
	} else if (k == 5 && !strncmp(kv, "error", 5)) {
		if ((n = lookup(tbs_error_name, 5, v)) < 0)
			return -1;
		cur.last_error = n;
	} else if (k == 4 && !strncmp(kv, "slot", 4)) {
		if ((n = lookup(tbs_slot_name, 3, v)) < 0)
			return -1;
		cur.slot = n;
	} else if (k == 8 && !strncmp(kv, "attempts", 8)) {
		n = atoi(v);
		if (n < 0 || n > 255)
			return -1;
		cur.attempts = n;
	} else if (k == 3 && !strncmp(kv, "max", 3)) {
		n = atoi(v);
		if (n < 1 || n > 20)
			return -1;
		cur.max_attempts = n;
	} else {
		return -1;
	}
	return 0;
}

/* tb.slot=<cache|a|b|rescue> on /proc/cmdline (set by U-Boot): the slot index, or -1 (rescue, or not given) */
static int booted_slot(void)
{
	char buf[4096], *p;
	FILE *f = fopen("/proc/cmdline", "r");
	size_t n = f ? fread(buf, 1, sizeof(buf) - 1, f) : 0;

	if (f)
		fclose(f);
	buf[n] = 0;
	for (p = strtok(buf, " \n"); p; p = strtok(NULL, " \n"))
		if (!strncmp(p, "tb.slot=", 8))
			return lookup(tbs_slot_name, 3, p + 8);
	return -1;
}

int main(int argc, char **argv)
{
	unsigned long long sectors = 0;
	const char *cmd = argc > 1 ? argv[1] : "show";
	int fd, i, write = strcmp(cmd, "show") != 0;

	if (sizeof(struct tbstate) != 512 || posix_memalign((void **)&blk, 4096, 1024))
		return 2;
	if (find_part(dev, sizeof(dev), &sectors) || sectors < TBS_PART_MIN_SECTORS || sectors > TBS_PART_MAX_SECTORS) {
		fprintf(stderr, "tbstate: no `%s` partition of %d..%d sectors\n", TBS_PART, TBS_PART_MIN_SECTORS,
			TBS_PART_MAX_SECTORS);
		return 1;
	}
	fd = open(dev, (write ? O_RDWR | O_SYNC : O_RDONLY) | O_DIRECT);
	if (fd < 0) {
		fprintf(stderr, "tbstate: %s: %s\n", dev, strerror(errno));
		return 1;
	}
	load(fd);
	if (!strcmp(cmd, "show")) {
		show();
		return 0;
	}
	if (!strcmp(cmd, "healthy")) {
		cur.attempts = 0;
		cur.last_stage = TBS_S_HEALTHY;
		cur.last_error = TBS_E_NONE;
		i = booted_slot();
		if (i >= 0)
			cur.last_good_slot = i;
	} else if (!strcmp(cmd, "stage") && argc == 3) {
		if ((i = lookup(tbs_stage_name, 5, argv[2])) < 0)
			goto usage;
		cur.last_stage = i;
	} else if (!strcmp(cmd, "set") && argc >= 3) {
		for (i = 2; i < argc; i++)
			if (set(argv[i]))
				goto usage;
	} else {
		goto usage;
	}
	if (save(fd))
		return 1;
	show();
	return 0;
usage:
	fprintf(stderr, "usage: tbstate [show] | set key=value... | stage <name> | healthy\n");
	return 2;
}

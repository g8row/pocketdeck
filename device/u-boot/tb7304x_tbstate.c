// SPDX-License-Identifier: GPL-2.0
/*
 * TB-7304X: the boot record (tbstate.h, docs/mainline/plan-dualboot.md §4) as a U-Boot command for boot.cmd.
 *
 *   tbstate load              read both copies, keep the newest valid one, export it to the environment:
 *                             tb_state (ok|blank|corrupt) tb_default tb_oneshot tb_attempts tb_max tb_stage
 *                             tb_error tb_slot tb_gen. blank = no copy carries the magic (first boot): defaults
 *                             (linux, 3 attempts). corrupt = a magic is present but no copy is valid.
 *   tbstate set <field> <v>   default|oneshot (none|linux|android|fastboot), error (none|attempts|...), max <n>,
 *                             slot (cache|a|b)
 *   tbstate attempt           attempts++, last_stage=uboot, linux_boots++ (before booting Linux)
 *   tbstate fail <error>      last_error=<error>, fallbacks++ (when falling back to Android)
 *   tbstate save              generation++, CRC, write over the OLDER copy, read back and compare
 *   tbstate show              print the record
 *
 * This is the only place U-Boot writes the eMMC, and it can only write the two record sectors of the 1 MiB
 * `tbstate` partition (TBS_AREA_SECTOR and TBS_AREA_SECTOR + TBS_COPY_STRIDE).
 */
#include <common.h>
#include <command.h>
#include <env.h>
#include <blk.h>
#include <part.h>
#include <memalign.h>
#include <u-boot/crc.h>
#include "tbstate.h"

static struct tbstate tbs_cur;
static int tbs_loaded;
static const char *tbs_state = "?";	/* ok | blank | corrupt, from the last load/save */

static int tbs_locate(struct blk_desc **dev, lbaint_t *base)
{
	struct disk_partition info;

	*dev = blk_get_dev("mmc", 0);
	if (!*dev)
		return -ENODEV;
	if (part_get_info_by_name(*dev, TBS_PART, &info) < 0)
		return -ENOENT;
	if (info.blksz != 512 || info.size < TBS_PART_MIN_SECTORS || info.size > TBS_PART_MAX_SECTORS)
		return -EINVAL;
	*base = info.start + TBS_AREA_SECTOR;
	return 0;
}

static u32 tbs_crc(const struct tbstate *s)
{
	struct tbstate t = *s;

	t.crc = 0;
	return crc32(0, (const unsigned char *)&t, sizeof(t));
}

static int tbs_valid(const struct tbstate *s)
{
	return s->magic == TBS_MAGIC && s->version == TBS_VERSION && s->crc == tbs_crc(s);
}

static const char *tbs_name(const char *const *names, int n, unsigned int v)
{
	return v < n ? names[v] : "?";
}

static int tbs_lookup(const char *const *names, int n, const char *s)
{
	int i;

	for (i = 0; i < n; i++)
		if (!strcmp(names[i], s))
			return i;
	return -1;
}

static void tbs_export(const char *state)
{
	const struct tbstate *s = &tbs_cur;

	tbs_state = state;
	env_set("tb_state", state);
	env_set("tb_default", tbs_name(tbs_target_name, 4, s->default_target));
	env_set("tb_oneshot", tbs_name(tbs_target_name, 4, s->oneshot));
	env_set_ulong("tb_attempts", s->attempts);
	env_set_ulong("tb_max", s->max_attempts);
	env_set("tb_stage", tbs_name(tbs_stage_name, 5, s->last_stage));
	env_set("tb_error", tbs_name(tbs_error_name, 5, s->last_error));
	env_set("tb_slot", tbs_name(tbs_slot_name, 3, s->slot));
	env_set_ulong("tb_gen", s->generation);
}

static void tbs_defaults(void)
{
	memset(&tbs_cur, 0, sizeof(tbs_cur));
	tbs_cur.magic = TBS_MAGIC;
	tbs_cur.version = TBS_VERSION;
	tbs_cur.default_target = TBS_T_LINUX;
	tbs_cur.max_attempts = 3;
}

static int tbs_load(void)
{
	ALLOC_CACHE_ALIGN_BUFFER(struct tbstate, c, 2);
	struct blk_desc *dev;
	lbaint_t base;
	int i, best = -1, magic = 0, ret;

	ret = tbs_locate(&dev, &base);
	if (ret) {
		printf("tbstate: no `%s` partition on mmc 0 (%d)\n", TBS_PART, ret);
		return ret;
	}
	for (i = 0; i < 2; i++) {
		if (blk_dread(dev, base + i * TBS_COPY_STRIDE, 1, &c[i]) != 1) {
			printf("tbstate: read of copy %d failed\n", i);
			memset(&c[i], 0, sizeof(c[i]));
		}
		magic |= c[i].magic == TBS_MAGIC;
		if (tbs_valid(&c[i]) && (best < 0 || c[i].generation > c[best].generation))
			best = i;
	}
	tbs_loaded = 1;
	if (best >= 0) {
		tbs_cur = c[best];
		tbs_export("ok");
	} else {
		tbs_defaults();
		tbs_export(magic ? "corrupt" : "blank");
	}
	return 0;
}

static int tbs_save(void)
{
	ALLOC_CACHE_ALIGN_BUFFER(struct tbstate, w, 1);
	ALLOC_CACHE_ALIGN_BUFFER(struct tbstate, r, 1);
	struct blk_desc *dev;
	lbaint_t base, lba;
	int ret;

	if (!tbs_loaded) {
		printf("tbstate: save without load\n");
		return -EINVAL;
	}
	ret = tbs_locate(&dev, &base);
	if (ret)
		return ret;
	tbs_cur.generation++;
	tbs_cur.crc = tbs_crc(&tbs_cur);
	*w = tbs_cur;
	/* copy (generation & 1): the newer copy has the other parity, so this overwrites the older one */
	lba = base + (tbs_cur.generation & 1) * TBS_COPY_STRIDE;
	if (blk_dwrite(dev, lba, 1, w) != 1 || blk_dread(dev, lba, 1, r) != 1 || memcmp(w, r, sizeof(*w))) {
		printf("tbstate: write of generation %u at LBA " LBAF " failed\n", tbs_cur.generation, lba);
		return -EIO;
	}
	tbs_export("ok");
	return 0;
}

static void tbs_show(void)
{
	const struct tbstate *s = &tbs_cur;

	printf("tbstate: %s gen %u default %s oneshot %s slot %s attempts %u/%u stage %s error %s boots %u fallbacks %u\n",
	       tbs_state, s->generation, tbs_name(tbs_target_name, 4, s->default_target),
	       tbs_name(tbs_target_name, 4, s->oneshot), tbs_name(tbs_slot_name, 3, s->slot), s->attempts,
	       s->max_attempts, tbs_name(tbs_stage_name, 5, s->last_stage),
	       tbs_name(tbs_error_name, 5, s->last_error), s->linux_boots, s->fallbacks);
}

static int do_tbstate(struct cmd_tbl *cmdtp, int flag, int argc, char *const argv[])
{
	int v;

	if (argc < 2)
		return CMD_RET_USAGE;
	if (!strcmp(argv[1], "load"))
		return tbs_load() ? CMD_RET_FAILURE : CMD_RET_SUCCESS;
	if (!tbs_loaded) {
		printf("tbstate: run `tbstate load` first\n");
		return CMD_RET_FAILURE;
	}
	if (!strcmp(argv[1], "save"))
		return tbs_save() ? CMD_RET_FAILURE : CMD_RET_SUCCESS;
	if (!strcmp(argv[1], "show")) {
		tbs_show();
		return CMD_RET_SUCCESS;
	}
	if (!strcmp(argv[1], "attempt")) {
		if (tbs_cur.attempts < 255)
			tbs_cur.attempts++;
		tbs_cur.last_stage = TBS_S_UBOOT;
		tbs_cur.linux_boots++;
		tbs_export(tbs_state);
		return CMD_RET_SUCCESS;
	}
	if (!strcmp(argv[1], "fail") && argc == 3) {
		v = tbs_lookup(tbs_error_name, 5, argv[2]);
		if (v < 0)
			return CMD_RET_USAGE;
		tbs_cur.last_error = v;
		tbs_cur.fallbacks++;
		tbs_export(tbs_state);
		return CMD_RET_SUCCESS;
	}
	if (!strcmp(argv[1], "set") && argc == 4) {
		if (!strcmp(argv[2], "default") || !strcmp(argv[2], "oneshot")) {
			v = tbs_lookup(tbs_target_name, 4, argv[3]);
			if (v < 0 || (!strcmp(argv[2], "default") && v != TBS_T_LINUX && v != TBS_T_ANDROID))
				return CMD_RET_USAGE;
			if (argv[2][0] == 'd')
				tbs_cur.default_target = v;
			else
				tbs_cur.oneshot = v;
		} else if (!strcmp(argv[2], "error")) {
			v = tbs_lookup(tbs_error_name, 5, argv[3]);
			if (v < 0)
				return CMD_RET_USAGE;
			tbs_cur.last_error = v;
		} else if (!strcmp(argv[2], "slot")) {
			v = tbs_lookup(tbs_slot_name, 3, argv[3]);
			if (v < 0)
				return CMD_RET_USAGE;
			tbs_cur.slot = v;
		} else if (!strcmp(argv[2], "max")) {
			v = simple_strtoul(argv[3], NULL, 10);
			if (v < 1 || v > 20)
				return CMD_RET_USAGE;
			tbs_cur.max_attempts = v;
		} else {
			return CMD_RET_USAGE;
		}
		tbs_export(tbs_state);
		return CMD_RET_SUCCESS;
	}
	return CMD_RET_USAGE;
}

U_BOOT_CMD(tbstate, 4, 0, do_tbstate, "TB-7304X boot record (two copies in the `tbstate` partition)",
	   "load | save | show | attempt | fail <error> | set default|oneshot|error|max|slot <value>");

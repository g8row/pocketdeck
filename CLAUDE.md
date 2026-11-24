# PocketDeck: notes for agents and contributors

Mainline Linux (7.0, Alpine) on a Lenovo TB-7304X (MT6737M) tablet, used as a desk display. Stock LK → U-Boot (in
`boot`) → Linux from raw kernel slots `tbkern_a/b` + ext4 roots `tbroot_a/b`; Android + Magisk in `recovery` as the
rollback. The UI is PocketJS (submodule) fed by `deckd` (Bun) on the host.

## Commands

`./pd help` lists everything. The ones used every day:

| | |
|---|---|
| `./pd state` | kernel, running slot, boot record (`tbstate`), installed builds, UI service. Run this first |
| `./pd ssh '<cmd>'` | command on the tablet (`root@172.16.42.1`, USB network; `/usr/local/sbin` on PATH) |
| `./pd build kernel\|rootfs\|all` | Docker build, local or on `PD_BUILD_HOST` from `.pd.env` (untracked) |
| `./pd ramboot` | boot `device/out/boot-mainline-uboot.img` from RAM, nothing written |
| `./pd install kernel rootfs` | write the **inactive** slot; then `./pd slot <x> && ./pd reboot linux` |
| `./pd deploy` | build + install the UI (`pocketdeck-ui` service); `./pd log ui` |
| `cd deckd && bun test` | deckd unit tests |

## Hard rules (each one cost a BROM recovery or a lost evening)

- Wait for `healthy` (60 s after stage 2 starts; `pd state`) between test reboots. 3 Linux boots without it →
  `tbrescue` → Android. Re-arm with `pd slot <x>`.
- Never write the running slot. Never write `para` (a BCB there hides LK's recovery menu; only BROM fixes it), `lk`,
  `preloader`, `seccfg`, `nvram`, `nvdata`, `protect1/2`. `recovery` holds Android: never flash test images there.
- Anything LK boots directly (`boot`) must pass `device/analysis/lk_image_check.py` (`pd flash uboot` runs it).
- Leave Android only via `pd reboot` / `tools/linux-test.sh` (Magisk's boot counter disables modules otherwise, and
  Android then never finishes booting).
- Don't read `/sys/kernel/debug/clk/clk_summary` (locks up the SoC). `reboot -f` can hang: use `tb-reboot` / sysrq.
- Stock `fastboot` stalls against LK: use `tools/fbusb`. U-Boot's fastboot is fine with the stock tool.
- Never `nmcli d connect` the tablet's USB interface.
- Ask before anything that writes the tablet's flash, and say which partition.

## Where to look

| Task | Read |
|---|---|
| What works, numbers, open items | `docs/hardware/status.md` |
| Boot flow, partitions, `tbstate`, slots | `docs/architecture/boot-chain.md` |
| Something is broken on the tablet | `docs/install/recovery.md` |
| Builds, inputs, BUILDINFO | `docs/dev/build.md` |
| Why things are the way they are | `docs/dev/lessons.md` |
| A subsystem (display, power, WiFi, LK) | `docs/hardware/research-*.md` |
| UI code | `pocketjs/apps/desk/` (the deck app), `pocketjs/hosts/android/src/kiosk*.rs` (Linux host) |
| Host daemon | `deckd/README.md` |

Layout: `device/` = everything that ends up on the tablet (its Docker build mounts it at `/m`, keep its inner
layout), `tools/` = host scripts, `deckd/`, `pocketjs/` (submodule, branch `android-host`), `archive/android/`.
Keep scratch files in `device/out/work/` (git-ignored), not in temp dirs.
Machine-specific setup (build host, paths) lives in the git-ignored `.pd.env` and `CLAUDE.local.md`; read
the latter if it exists.

## Conventions

- Commit prefixes: `kernel:` `boot:` `rootfs:` `ui:` `deckd:` `tools:` `docs:` `repo:` or a hardware area
  (`power:`, `display:`, `wifi:`, `bluetooth:`). Branches `feat/…`, `fix/…`, `bringup/…`, `docs/…`; `main` only
  gets device-tested states.
- On-device `tb*` names (partitions, `tbstate`, `tb-reboot`) and `/opt/pocketjs` are stable on purpose.
- Docs: update `docs/hardware/status.md` when hardware behaviour changes (name the build by `git describe`), add a
  line to `docs/dev/lessons.md` for anything that cost time, list new docs in `docs/index.md`.
- Public repo: no host names, user names, home/build paths, LAN addresses or keys in tracked files; never commit
  `backup/` (IMEI/NVRAM).

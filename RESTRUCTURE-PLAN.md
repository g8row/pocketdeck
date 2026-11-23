# PocketDeck restructure plan (v2)

Status: **in progress** on branch `repo/restructure`. v1 (2026-11-20) was reviewed on 2026-11-23 against the repo
and the live tablet; this version replaces it. Progress is tracked in §9.

Goal: the project becomes **PocketDeck**, a Linux-first product. The device path is
**back up + root → repartition → U-Boot → Linux → PocketDeck**, and the repo, docs and tooling show exactly that path.
Android stays as the rollback slot on the tablet and as history in git.

## 1. Decisions

| Topic | Decision |
|---|---|
| Name | **PocketDeck**; GitHub repo renamed in place (`desk-companion` → `pocketdeck`, history and redirects kept) |
| Daemon | **`deckd`** (was `deskd`) |
| UI app | **`deck`**; **Deck Studio** (was Desk Studio). The app stays in the pocketjs submodule until pocketjs has a Linux host (§7) |
| On-device service | `pocketjs` → **`pocketdeck-ui`** (OpenRC). `/opt/pocketjs` and the binary name stay for now |
| On-device `tb*` names | **Unchanged** (`tbkern_a`, `tbroot_a`, `tbdata`, `tbstate`, `tb-reboot`, …): they are in the flashed GPT and U-Boot. `tb` = TB-7304X, stable on purpose |
| History | **Not copied.** Superseded docs are deleted from the tree and stay readable at tag `android-era-final`; `docs/history/README.md` lists them, `docs/dev/lessons.md` keeps what they taught |
| Machines | No host names, user paths, LAN addresses or personal keys in the repo. Per-developer settings live in an untracked `.pd.env` |

## 2. Principles

1. Linux is the main path. Nothing at the top of the README or in `docs/install/` is Android-first.
2. One live status file, one ordered install path, one lessons file.
3. Every install stage has a doc, a `pd` command and a "you are here / you need / you end with" header.
4. `main` only moves to states that were tested on the device.
5. History preserved: moves are renames git can follow; merge commit, no squash.
6. Nothing on the device is rewritten without a tested way back. New images go to the **inactive slot** first.

## 3. Vocabulary

| Old | New |
|---|---|
| desk-companion, "desk companion" | **pocketdeck**, PocketDeck |
| deskd, `DESKD_*`, `desk.config.json`, `x-desk-token` | **deckd**, `DECKD_*` (old names read as fallback for one release), `deck.config.json` (old file read as fallback), `x-deck-token` |
| kiosk (Linux), "kiosk mode" | **Linux host** / **UI**; the binary stays `pocketjs-kiosk` until pocketjs renames it (§7) |
| mainline/ | **device/** ("mainline" only meant "not Android") |
| dual boot, plan-dualboot | **boot chain** |
| debloat/, kiosk/ (Android) | **archive/android/** |
| LOG.md, PLAN-*.md, plan-boot-recovery.md, handoffs, TEST-PLAN | deleted; listed in `docs/history/README.md` |

## 4. Target layout

```
pocketdeck/
├─ README.md            what it is, screenshot, the stage table, links
├─ CLAUDE.md            agent/contributor quick reference: commands, hazards, where things are
├─ pd                   the CLI (§6)
├─ docs/
│  ├─ index.md          one line per doc
│  ├─ install/          00-prerequisites … 05-pocketdeck, recovery.md
│  ├─ hardware/         status.md (THE live status), research-*.md
│  ├─ architecture/     boot-chain.md, deckd.md
│  ├─ dev/              build.md, workflow.md (RAM boots, slots, deploy loop), lessons.md, conventions.md
│  ├─ assets/           screenshots/, boot-screens/
│  └─ history/README.md retired docs and how to read them (`git show android-era-final:<path>`)
├─ device/              everything that ends up on the tablet; same inner layout as mainline/ had, so the
│  │                    Docker build (mounted at /m) keeps its paths
│  ├─ build/            Dockerfile, build.sh, build-in-docker.sh, wcn-build.sh
│  ├─ analysis/         lk_image_check.py, fb_send.py, LK disassembly helpers, memtest.c
│  ├─ dts/ patches/ initramfs/ u-boot/ rootfs/ gpu/ wcn/ wcn-tools/ stock/
│  └─ out/ src/         build outputs and source checkouts (gitignored)
├─ deckd/               Bun daemon, Deck Studio, hooks, linux/ (systemd user unit)
├─ pocketjs/            submodule (framework, hosts, the `deck` app in apps/desk until §7)
├─ tools/               host-side scripts: tb.sh, ramboot.sh, tb-install.sh, linux-test.sh, pocketjs-deploy.sh,
│                       wifi-deploy.sh, tablet-net.sh, http-proxy.py, mlsh.py, fb2png.py, fbusb, tb-gpt.py,
│                       bootscreens/, pane-perf.sh
├─ backup/              local device dumps (gitignored; build input for stock DTB/firmware, never published)
└─ archive/android/     debloat/ (Magisk module, package lists), kiosk/ (Android kiosk), README.md
```

Changes from v1, and why:
- `device/` keeps mainline's flat inner layout instead of `kernel/`, `bootloader/`, `partitions/`: the Docker build
  hard-codes `/m/patches`, `/m/u-boot`, `/m/scripts/analysis`…; flat means pure moves with a handful of path edits.
- The submodule stays at `pocketjs/` and the app stays inside it until pocketjs has `hosts/linux`; moving it twice
  costs more than it buys.
- `backup/` stays at the top: it is the stage 1 output and the build reads the stock DTB, firmware and NVRAM from it.
- No `docs/history/` copies (see §1).

## 5. The device path

| Stage | Goal | Doc | Command | Done when |
|---|---|---|---|---|
| 0 | Host ready | `00-prerequisites.md` | `pd doctor` | all checks green |
| 1 | Backup, unlock, root | `01-backup-unlock-root.md` | mtkclient + Magisk (manual; `pd doctor` checks the backup) | full dump in `backup/partitions`, Magisk root |
| 2 | Repartition | `02-repartition.md` | `tools/tb-gpt.py` (manual, documented) | `tb*` partitions in the GPT |
| 3 | U-Boot in `boot` | `03-uboot.md` | `pd build uboot`, `pd flash uboot` | U-Boot → Linux by default, Android in `recovery` |
| 4 | Linux installed | `04-linux.md` | `pd build`, `pd install kernel rootfs` | Alpine from eMMC reaches `healthy` |
| 5 | PocketDeck | `05-pocketdeck.md` | `pd deploy`, `pd deckd` | UI on screen, deckd connected |
| – | Rollback | `recovery.md` | `pd reboot android`, `pd slot a`, `pd state` | back to a known-good state |

Stages 1–3 are one-time and dangerous; they stay documented step-by-step rather than hidden behind one command.

## 6. `pd`

POSIX shell at the repo root, runnable from anywhere, wrapping the existing scripts (no new logic beyond argument
checks, preconditions and clear errors). Settings from the environment or the untracked `.pd.env`:
`TAB` (tablet ssh target, default `root@172.16.42.1`), `PD_BUILD_HOST` / `PD_BUILD_DIR` (remote Docker host for
kernel/U-Boot/rootfs/Mesa builds; unset = local Docker).

```
pd doctor                         host tools, submodule, backup, tablet reachability
pd ssh [cmd]                      shell / command on the tablet
pd state                          boot record, running slot, kernel, release info, services
pd log [ui|kernel|deckd]          tail logs
pd build [kernel|uboot|wcn|rootfs|mesa|all]   local Docker, or PD_BUILD_HOST (rsync, build, fetch device/out)
pd ramboot [image]                RAM-boot via U-Boot fastboot (nothing written)
pd install kernel|rootfs [--slot a|b] [--yes]  default slot: the inactive one
pd slot a|b                       which slot U-Boot boots next (record), resets attempts
pd deploy [manifest]              build + push the UI, restart pocketdeck-ui
pd deckd [--install]              run deckd here, or install it as a systemd user service
pd boot default linux|android
pd reboot linux|android|android-direct|uboot|bootloader
pd flash uboot [--yes]            U-Boot image to `boot` via LK fastboot, after lk_image_check
```

Safety: everything that writes flash names the partition and needs `--yes` (or a typed confirmation); `pd install`
refuses to write the running slot's root; `pd state` explains the attempt counter.

### Slot updates (new; v1 assumed this existed)
`tb-install.sh` only wrote slot A, so a root update needed a RAM boot and had no rollback. U-Boot, `tbstate` and stage
1 already support slot B (T9). The update flow becomes:
1. `pd install kernel rootfs` → writes `tbkern_b` + `tbroot_b` while running from A (no RAM boot), verifies hashes,
   carries `/opt/pocketjs`, `/etc/firmware` and host keys over from the running root.
2. `pd slot b && pd reboot linux` → U-Boot boots B. Healthy at 60 s → `last_good_slot=b`.
3. If B never gets healthy: 3 attempts → `tbrescue` → Android. From Android or rescue: `pd slot a`, `pd reboot linux`.

### Build identity (new)
Kernel build numbers (`#18`) differ per build machine and were mixed up in the docs. `pd build` passes
`git describe --dirty` into the kernel (`KBUILD_BUILD_VERSION`, shown by `uname -v`) and writes
`device/out/BUILDINFO` (describe, kernel commit, image hashes); `pd install` stores it on the tablet as
`/data/pocketdeck/slot-<x>.buildinfo` and `pd state` prints it. The status doc names builds by describe + date.

## 7. pocketjs (separate repo, separate PRs; no longer gates this restructure)

- `hosts/linux`: the DRM/KMS host and musl build from `hosts/android/src/kiosk*.rs`, binary `pocketjs-linux`.
- Platform id `kiosk` → `linux` in `contracts/spec/*`, `docs/WIDGET.md`.
- Merge `android-host` into pocketjs `main`; the submodule then tracks `main`.
- Then, in this repo: `apps/desk` → `ui/` (app `deck`) building against the submodule, the deploy script and deckd's
  watcher pointed at `ui/`, binary rename in `pocketdeck-ui`. Check: same bundle bytes as before the move.

## 8. Conventions

- Branches: `feat/<area>-<thing>`, `fix/…`, `bringup/<hardware>`, `docs/…`, `chore/…`, short-lived.
  Frozen: `archive/mainline-bringup` (renamed from `mainline-bringup`), tag `android-era-final`.
- Commit prefixes: `kernel:` `boot:` `rootfs:` `ui:` `deckd:` `tools:` `docs:` `repo:` (plus hardware areas already
  in use: `power:`, `display:`, `wifi:`, `bluetooth:`).
- Tags: existing `bootscreens-ridge-1`, `mainline-test-1`, `stock-partitions-1` stay (scripts download from them).
  Releases `v0.N.0` after device verification; notes list the BUILDINFO of what was tested.
- Docs: one live status file stating the build it was verified on; research notes start with
  `Status: current | superseded`; no dated filenames; adding a doc means a line in `docs/index.md`; install docs
  use `pd` commands only.

## 9. Execution and progress

| # | Step | Needs | State |
|---|---|---|---|
| 1 | Freeze: local tag `android-era-final` at the pre-restructure `main`; rename `mainline-bringup` → `archive/mainline-bringup` locally | – | |
| 2 | Retire history docs (delete; `docs/history/README.md`, `docs/dev/lessons.md`) | – | |
| 3 | Moves, one commit per top-level move, `.gitignore` updated in the same commit (`mainline/out` is ~600 MB) | – | |
| 4 | Path fixes after the moves, then renames (deskd → deckd, env/config fallbacks, kiosk/mainline prose, service name); update local Claude Code hook paths | – | |
| 5 | `pd`, `.pd.env.example`, slot-B install, build identity | – | |
| 6 | Docs: README, CLAUDE.md, index, install/, architecture/, dev/, compacted status + research; CI (deckd tests, shellcheck, link check, stale-name grep) | – | |
| 7 | Device verification (§10): build, install to slot B, boot B, deploy, deckd | user OK (writes flash) | |
| 8 | Publish: push tag + branches, GitHub rename, `git remote set-url`, merge (no squash), `v0.1.0` | user OK (public) | |
| 9 | pocketjs work (§7) | separate | |

On the build machine after step 3: move its `mainline/` checkout to `device/` (or let `pd build` rsync a fresh one;
the kernel/U-Boot objects live in Docker volumes and survive either way).

## 10. Definition of done

- [ ] `git log --follow` works on a moved file per top-level move
- [ ] stale-name grep is clean outside `archive/` and `docs/history/`
- [ ] `bun test` in deckd passes; `pd --help` and every subcommand's `--help` work; `pd doctor` passes
- [ ] `pd build all` completes (local Docker or `PD_BUILD_HOST`), `uname -v` shows the describe
- [ ] `pd install kernel rootfs` → slot B; `pd slot b`; reboot; `healthy` with `last_good_slot=b`
- [ ] `pd deploy`: UI at 60 Hz, `pocketdeck-ui` starts on boot, old `pocketjs` service gone
- [ ] `pd deckd`: connects, a tile action runs on the host, hot reload works; Claude Code hooks reach deckd
- [ ] Rollback: `pd slot a` boots A again; `pd reboot android` and back
- [ ] A new reader can follow `docs/install/` 0 → 5 without history docs; all links resolve
- [ ] No host names, user paths, LAN addresses or keys in the tree (grep in CI)

## 11. Risks

| Risk | Mitigation |
|---|---|
| Moving `mainline/` drags untracked build output into a commit | `.gitignore` changes in the same commit; `git status` must show renames only |
| Moving `deskd/` breaks the Claude Code hooks (absolute paths) | hook paths updated in the same step; `claude-hook.sh` never blocks anyway |
| Service rename leaves the tablet without a UI | deploy installs the new service before removing the old one; tested with `pd deploy` before any rootfs install |
| New root/kernel does not boot | written to slot B only; A untouched; 3-attempt fallback to rescue → Android; `pd slot a` |
| Boot counter trips during testing | wait for `healthy` (60 s) between reboots; `pd state` shows attempts |
| Renaming wire/config names breaks a running setup | fallbacks for `DESKD_*` and `desk.config.json` for one release |
| Personal data in published history | retired docs are deleted from the tree; before the public push, review tag contents; CI grep for host names/paths |

## 12. Out of scope

Renaming on-device `tb*` identifiers and `/opt/pocketjs`; new UI/daemon features (a DRM screenshot tool for `pd shot`
is the first follow-up); Android host maintenance; other tablets.

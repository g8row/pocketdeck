# PocketDeck restructure plan

Status: **plan, nothing executed yet.** Written 2026-11-20 against `main` at `a7b76ec`.

Goal: the project becomes **PocketDeck**, a Linux-first product. The path for the device is
**root → reflash → set U-Boot to boot Linux → start PocketDeck**, and the repo, docs and build files show exactly
that path. Android stays only as history and as the rollback slot on the tablet.

## 1. Decisions (settled)

| Topic | Decision |
|---|---|
| Product / repo name | **PocketDeck**, GitHub repo `g8row/pocketdeck` |
| Daemon | **`deckd`** (was `deskd`) |
| UI app | **`deck`** (was `desk` app, `apps/desk`); the DECK tile pane keeps its name; **Deck Studio** (was Desk Studio) |
| Repo strategy | **Rename `desk-companion` in place.** History, tags and redirects are kept. No new repo |
| UI app location | `ui/` in this repo, depending on pocketjs as a submodule (moved out of `pocketjs/apps/desk`) |
| On-device `tb*` names | **Unchanged for now** (`tbkern_a`, `tbroot_a`, `tbdata`, `tbstate`, `tb-reboot`, `tb.sh`…). Renaming means changing the flashed GPT and hard-coded U-Boot, which risks a brick. Separate project, see §11 |

Open assumption: "deck" in the decision was read as "the UI app/pane is called deck". If the DECK tile pane should
be renamed instead, only §3 and `ui/` change.

## 2. Principles

1. Linux is the main path. Nothing in the top level of the repo, the README or `docs/install/` is Android-first.
2. One status file. One ordered install path. Everything dated or superseded goes to `docs/history/`.
3. Every stage of the device path has: a doc, a command, a "you are here / you need / you end with" header.
4. `main` always matches something that was tested on the device.
5. History is preserved (`git mv`, no squash). The Android era is reachable by tag and under `archive/android/`.
6. Nothing renamed on the device side without a tested recovery path (§11).

## 3. Vocabulary

| Old | New | Notes |
|---|---|---|
| desk-companion | **pocketdeck** | repo, README title, docs |
| deskd | **deckd** | dir, package name, log file, env vars (`DESKD_*` → `DECKD_*`, keep old as fallback for one release), systemd unit |
| apps/desk (Desk app) | **ui/** (app name `deck`) | |
| Desk Studio | **Deck Studio** | |
| `deskconfig.ts`, `desk.json`-style files | `deckconfig.ts` etc. | rename with the daemon |
| kiosk, `pocketjs-kiosk` | **PocketJS Linux host**, binary **`pocketjs-linux`** | OpenRC service `pocketjs` → `pocketdeck-ui` |
| `hosts/android` building the Linux binary | `hosts/linux` (DRM/KMS) + `hosts/android` (frozen) | change is in the pocketjs repo |
| mainline/ | **device/** | "mainline" only meant "not Android" |
| "dual boot", plan-dualboot | **boot chain** | U-Boot → Linux (default), Android (recovery slot, rollback) |
| debloat/, kiosk/, backup/, Android host notes | **archive/android/** | history only |
| LOG.md, PLAN-*.md, plan-boot-recovery.md, handoffs | **docs/history/** | |
| `tools/` (Mac-side helper scripts) | `tools/` | stays; the bring-up scripts from `mainline/scripts` move here |

Terminology to retire in prose: "kiosk mode", "Android mode", "mainline" as a name for the system, "desk-companion",
"companion".

## 4. Target layout

```
pocketdeck/
├─ README.md                  what it is, one screenshot, the 5-stage path, links
├─ LICENSE
├─ pd                         single CLI entry point (§6)
├─ docs/
│  ├─ index.md                map of all docs
│  ├─ install/                the ordered path
│  │  ├─ 00-prerequisites.md
│  │  ├─ 01-backup-unlock-root.md
│  │  ├─ 02-reflash.md
│  │  ├─ 03-uboot.md
│  │  ├─ 04-linux.md
│  │  ├─ 05-pocketdeck.md
│  │  └─ recovery.md
│  ├─ hardware/
│  │  ├─ status.md            THE live status (was docs/mainline/STATUS.md)
│  │  └─ research-*.md        display, power, rootfs, wifi, poweroff, lk-bootflow
│  ├─ architecture/
│  │  ├─ boot-chain.md        (from plan-dualboot.md, rewritten as current design)
│  │  ├─ partition-layout.md
│  │  ├─ deckd-protocol.md    (from deskd/protocol.ts + README)
│  │  └─ ui.md
│  ├─ dev/
│  │  ├─ build.md             kernel, U-Boot, rootfs, ui, deckd
│  │  ├─ ramboot.md           RAM boots, the 60 s rule
│  │  ├─ test-plan.md         (from mainline/TEST-PLAN.md)
│  │  └─ conventions.md       branches, commits, docs rules (§8, §9)
│  └─ history/
│     ├─ README.md            what each file is and why it is no longer current
│     ├─ LOG.md
│     ├─ PLAN-overnight.md
│     ├─ plan-boot-recovery.md
│     └─ handoff-uboot-2026-11-17.md
├─ device/                    everything that is flashed to the tablet
│  ├─ bootloader/             u-boot/ (patches, config), LK notes + lk_image_check.py
│  ├─ kernel/                 patches/, dts/, config, wcn/ (MT6625L), gpu/ (Mesa build)
│  ├─ initramfs/              stage 1 (init, boot menu, health record)
│  ├─ rootfs/                 build-rootfs.sh, overlay/, tools/
│  └─ partitions/             GPT layout, stock-partition notes
├─ deckd/                     Bun daemon: providers, actions, hooks, Deck Studio, linux/ service
├─ ui/                        PocketJS app "deck" (panes, tiles)
├─ vendor/
│  └─ pocketjs/               submodule (framework, hosts/linux)
├─ tools/                     host scripts: tb.sh, ramboot.sh, linux-test.sh, mlsh.py, fb2png.py, fbusb…
└─ archive/
   └─ android/                debloat/, kiosk/, backup/, ONBOARDING (Android), android host notes, README
```

Build outputs (`device/out/`, kernel/U-Boot source checkouts) stay gitignored as today. Mapping of every current
path:

| Current | Target |
|---|---|
| `README.md` | `README.md` (rewritten) |
| `docs/ONBOARDING.md` | split into `docs/install/*`; Android parts → `archive/android/ONBOARDING.md` |
| `docs/mainline/STATUS.md` | `docs/hardware/status.md` |
| `docs/mainline/research-*.md` | `docs/hardware/research-*.md` |
| `docs/mainline/plan-dualboot.md` | `docs/architecture/boot-chain.md` (rewritten as present-tense design; old text → `docs/history/`) |
| `docs/mainline/handoff-uboot-2026-11-17.md` | `docs/history/` |
| `docs/screenshots/`, `docs/boot-screens/` | `docs/assets/screenshots/`, `docs/assets/boot-screens/` |
| `mainline/README.md` | split into `docs/dev/build.md`, `docs/dev/ramboot.md`, `docs/history/mainline-bringup-2026-11-16.md` |
| `mainline/TEST-PLAN.md` | `docs/dev/test-plan.md` |
| `mainline/patches`, `dts`, `wcn`, `gpu` | `device/kernel/…` |
| `mainline/u-boot`, `mainline/stock` | `device/bootloader/…`, `device/partitions/…` |
| `mainline/initramfs`, `mainline/rootfs` | `device/initramfs`, `device/rootfs` |
| `mainline/scripts` | `tools/` (build scripts that belong to one component go with it: `wcn-build.sh` → `device/kernel/`) |
| `mainline/wcn-tools` | `device/kernel/wcn-tools` |
| `mainline/out`, `mainline/src` | `device/out`, `device/src` (gitignored) |
| `deskd/` | `deckd/` |
| `pocketjs/` (submodule) | `vendor/pocketjs/` |
| `pocketjs/apps/desk` | `ui/` (in this repo) |
| `debloat/`, `kiosk/`, `backup/` | `archive/android/…` |
| `LOG.md`, `PLAN-overnight.md`, `plan-boot-recovery.md` | `docs/history/` |
| `tools/bootscreens`, `tools/pane-perf.sh` | `tools/` (unchanged) |

## 5. The device path (what the docs and `pd` present)

| Stage | Goal | Doc | Command | Output / done when |
|---|---|---|---|---|
| 0 | Host ready | `00-prerequisites.md` | `pd doctor` | all checks green (Bun, Rust+musl target, Docker, python+pyusb, fastboot tooling) |
| 1 | Back up, unlock bootloader, root | `01-backup-unlock-root.md` | `pd backup`, `pd root` | full dump on the host; Magisk root in the Android slot |
| 2 | Reflash the partition layout | `02-reflash.md` | `pd flash layout` | `tbkern_a`, `tbroot_a`, `tbdata`… exist (GPT verified) |
| 3 | U-Boot in `boot`, set to boot Linux | `03-uboot.md` | `pd flash uboot`, `pd boot default linux` | U-Boot menu appears; boot record says Linux default |
| 4 | Linux installed | `04-linux.md` | `pd build all`, `pd install kernel`, `pd install rootfs` | Alpine boots from eMMC, reaches `healthy` |
| 5 | PocketDeck running | `05-pocketdeck.md` | `pd deploy`, `pd deckd` | UI on screen, deckd connected, hot reload works |
| – | Rollback | `recovery.md` | `pd reboot android`, `pd state` | Android in `recovery`, boot counter explained |

Each stage doc begins with:

```
Stage N of 5 · you are here: <one line> · you need: <inputs> · you end with: <verifiable result>
Previous: <link> · Next: <link> · If it fails: recovery.md#<anchor>
```

Stage 1 note: rooting is only needed to reach the point where the partitions can be rewritten and U-Boot flashed.
The doc states exactly which later stage depends on it, and that the Android slot stays as rollback.

## 6. The `pd` CLI

A single POSIX-shell (or Bun, decide in implementation; default: shell, no dependency) script at the root. It wraps
existing scripts, adds no new logic of its own beyond argument checking, preconditions and clear errors. It must be
runnable from any directory.

```
pd doctor                      check host tools and device connectivity
pd backup                      full partition dump (mtkclient)         -> stage 1
pd root                        unlock + Magisk                         -> stage 1
pd flash layout|uboot          partition table / U-Boot                -> stages 2, 3
pd build kernel|rootfs|ui|deckd|all
pd ramboot                     RAM-boot the current kernel (waits 60 s before checks)
pd install kernel|rootfs       to the inactive slot, with backup       -> stage 4
pd deploy                      build ui + pocketjs-linux, push, restart service  -> stage 5
pd deckd [--dev]               run the daemon (or install the service on Linux)
pd boot default linux|android  boot record
pd reboot linux|android|uboot|bootloader
pd state                       boot record, slot, health, boot counter
pd log                         tail device logs
```

Mapping to today's scripts: `build.sh`/`build-in-docker.sh` → `build`; `ramboot.sh` → `ramboot`; `tb-install.sh` →
`install`; `pocketjs-deploy.sh` → `deploy`; `linux-test.sh`/`tb.sh` → `state`/`reboot`/`boot`. The wrapped scripts keep
their current names; renaming them is allowed only where the name contains `kiosk`, `mainline` or `desk`.

Safety rules in `pd`: anything that writes flash prints the target partition and requires `--yes` or an interactive
confirmation; `pd install` refuses if the boot record shows unhealthy boots until `pd state` is acknowledged; the
60-second wait after RAM boots (see memory note on boot counters) is built into `pd ramboot`.

## 7. Repo, submodule and pocketjs changes

### This repo
- Rename on GitHub: `desk-companion` → `pocketdeck`. Update `origin` locally. Old URLs redirect.
- Tag the last pre-restructure commit `android-era-final` before any move (§10, step 1).
- `.gitmodules`: `pocketjs` → `vendor/pocketjs`, `branch = main` once the Linux host is merged there.
- `private-history` stays local and unpushed. Verify with `git branch -r` before any push of branches.

### pocketjs repo (separate repo, separate PR; this is a prerequisite)
- Add `hosts/linux`: the DRM/KMS host and musl build, binary `pocketjs-linux`. Move the Linux-specific code out of
  `hosts/android/src/kiosk.rs`, `kiosk_drm.rs`.
- Leave `hosts/android` buildable but marked frozen in its README.
- Rename `kiosk` in `contracts/spec/pocket-manifest.ts`, `contracts/spec/platforms.ts`, `docs/WIDGET.md` (platform id
  `linux`).
- Merge `android-host` into pocketjs `main` once the above is done; PocketDeck's submodule then tracks `main`.
- Move `apps/desk` into PocketDeck `ui/`. The pocketjs `pocket.config.ts` / `pocket.json` project wiring needs a
  matching `ui/pocket.config.ts` that points to `vendor/pocketjs` as the framework root. Prove this builds before
  deleting the original (keep it in pocketjs until the PocketDeck build is verified).

## 8. Branch and tag conventions

- `main`: stable; every commit reachable from a tag that was tested on the device is marked in `docs/hardware/status.md`.
- Working branches, short-lived, one purpose, deleted after merge:
  `feat/<area>-<thing>`, `fix/<area>-<thing>`, `bringup/<hardware>`, `docs/<topic>`, `chore/<topic>`.
  Areas: `ui`, `deckd`, `kernel`, `boot`, `rootfs`, `tools`, `docs`.
- Frozen: `archive/android-era` (= tag `android-era-final`), `archive/mainline-bringup` (renamed from `mainline-bringup`).
- Releases: `v0.1.0` = first tagged state after the restructure is verified on the device. Release notes list what was
  verified (kernel build number, rootfs image hash, U-Boot image hash).
- Existing tags `bootscreens-ridge-1`, `mainline-test-1`, `stock-partitions-1` stay as they are (they are referenced
  from docs). New firmware-level tags: `fw/<component>-<n>`.
- Commit subject prefixes: `kernel:`, `boot:`, `rootfs:`, `ui:`, `deckd:`, `tools:`, `docs:`, `repo:`. Matches the
  existing style (`power:`, `display:`, `docs:`) with a fixed set.

## 9. Docs rules

1. **One live status file**: `docs/hardware/status.md`. It always states the kernel build and date it was verified on.
2. Research notes carry a header `Status: current | superseded by <link>`; superseded ones move to `docs/history/`.
3. No dated filenames outside `docs/history/`.
4. Install docs contain only commands that `pd` also runs, so doc and tooling cannot drift; `pd` is the source of
   truth for flags.
5. README top section: what it is (2 lines), the 5-stage path as a table with links, one screenshot. Nothing about
   Android above the "History" heading.
6. `docs/index.md` lists every doc in one line each. Adding a doc means adding a line.
7. Android material is always labelled "archive" in its path, never in the install path.
8. Rewrite, don't patch: `docs/architecture/boot-chain.md` is written fresh as the present design from
   `plan-dualboot.md`, `research-lk-bootflow.md` and `STATUS.md`.

## 10. Execution order

Each step ends in a commit (or a PR in the named repo) and a check. Do them in order.

1. **Freeze.** On `main`: tag `android-era-final`, push the tag. Create `archive/android-era` and
   `archive/mainline-bringup` (rename existing). Confirm `private-history` is not on the remote.
2. **pocketjs prerequisites** (pocketjs repo): `hosts/linux`, `pocketjs-linux` binary, platform id rename, merge to
   its `main`. Check: `hosts/linux` builds the musl binary and the RAM-booted tablet runs it.
3. **GitHub rename** `desk-companion` → `pocketdeck`; `git remote set-url origin …`. Check: `git fetch` works, old URL
   redirects.
4. **Branch `repo/restructure`**. Pure moves first, no content edits, one commit per top-level move so `git log
   --follow` keeps working: `docs/`, `device/`, `deckd/`, `tools/`, `archive/android/`, `docs/history/`,
   `vendor/pocketjs`. Check: `git status` shows renames only; `git diff -M --stat` has near-zero content change.
5. **Mechanical renames** via a script kept at `docs/history/restructure-rename.sh` (dry-run default, `--apply`):
   - `deskd` → `deckd`, `DESKD_` → `DECKD_` (with one-release fallback in config loading), `desk-companion` →
     `pocketdeck`, `Desk Studio` → `Deck Studio`;
   - `pocketjs-kiosk` → `pocketjs-linux`, remaining `kiosk` → `host`/`ui` by context (review the ~161 hits across
     ~30 files by hand; the script only lists them);
   - `mainline/` path references → `device/…`, `docs/mainline/` → `docs/hardware/`.
   Files touched include the tablet-side service (`rootfs/overlay/etc/init.d/pocketjs`,
   `conf.d/pocketjs` → `pocketdeck-ui`), `build-rootfs.sh`, `tools/pocketjs-deploy.sh`, `deckd/providers/tablet.ts`,
   `deckd/transport.ts`, `deckd/linux/*`, `.gitignore`. Check: `grep -rIi 'kiosk\|deskd\|desk-companion\|mainline/'
   --exclude-dir=.git --exclude-dir=archive --exclude-dir=history .` returns only intentional hits.
6. **Move the UI app**: `pocketjs/apps/desk` → `ui/`; make it build against `vendor/pocketjs`. Check: `pd build ui`
   produces the same bundle as before (diff the output).
7. **Write `pd`** and `pd doctor`; port the existing scripts behind it. Check: every subcommand has `--help`; dry-run
   output for the flash commands shows the partitions without writing.
8. **Write docs**: README, `docs/index.md`, `install/00…05`, `recovery.md`, `architecture/*`, `dev/*`,
   `history/README.md`, `archive/android/README.md`. Reuse text from the current docs; do not carry over Android-first
   framing. Check: a fresh reader can follow stage 0 → 5 using only `docs/install/` (see §12).
9. **Device verification** (see §12). Rootfs must be rebuilt and reinstalled because the on-device service and paths
   change (`pocketjs` → `pocketdeck-ui`, `/opt/pocketjs` paths). Keep the old installed root as fallback until verified;
   the boot counter will drop to Android after 3 unhealthy boots, so follow the 60 s rule.
10. **Merge and release**: merge `repo/restructure` into `main` (merge commit, not squash, to keep the per-move history),
    tag `v0.1.0`, update the Status header.

## 11. Deferred: renaming on-device identifiers

Not part of this plan. Candidates: GPT partition names `tbkern_a`/`tbroot_a`/`tbdata`, `tbstate`, `tb-reboot`,
`tb.sh`, `/opt/pocketjs`. Reason to defer: they are in the flashed GPT, U-Boot's environment/scripts and the boot
record; a mistake bricks the boot path. If done later: do it as a new slot-B style migration (create new names, boot
from them, then drop the old), with `pd` knowing both name sets for one release. Until then the docs state once, in
`docs/architecture/partition-layout.md`, that `tb` = "TB-7304X" and these names are stable on purpose.

## 12. Verification checklist (definition of done)

- [ ] `git log --follow` works on a moved file from each top-level move (e.g. `device/kernel/patches/…`, `deckd/main.ts`)
- [ ] grep check from §10 step 5 is clean
- [ ] `pd doctor` passes on the Mac and on the build host (taos)
- [ ] `pd build all` completes on both
- [ ] `pd ramboot` boots, waits 60 s, `pd state` shows healthy
- [ ] `pd install rootfs` completes; reboot; tablet reaches `healthy` from the eMMC
- [ ] `pd deploy`: UI on screen at 60 Hz, `pocketdeck-ui` service starts on boot
- [ ] `pd deckd`: deckd connects, a tile action runs on the Mac, UI hot reload works (~2 s)
- [ ] Rollback: `pd reboot android` and back to Linux
- [ ] Docs: someone who has not seen the project follows `docs/install/` stage 0 → 5 without needing history docs
- [ ] README links all resolve (check with a link checker)
- [ ] `docs/hardware/status.md` header shows the verified kernel build and date
- [ ] Old GitHub URL redirects; submodule clones with `git clone --recurse-submodules`

## 13. Risks

| Risk | Mitigation |
|---|---|
| Moves break the rootfs build or scripts that use relative paths | Do pure moves first (§10 step 4), then fix paths in step 5; `pd build all` is the check |
| Service rename leaves the tablet without a UI | Keep the old root installed until verified; ramboot first; the boot counter returns to Android on failure |
| Boot counter trips during testing (3 quick reboots → Android) | 60 s rule in `pd ramboot`; recovery steps in `recovery.md` |
| pocketjs changes block this repo | pocketjs prerequisites are step 2 and gate the rest; the UI move (step 6) comes after |
| Broken doc links after moves | Link check in §12; `docs/index.md` is the map |
| History lost to bulk rename | `git mv` only, merge commit not squash, rename script is reviewed with dry run |
| Secrets or personal paths in history docs | Skim `docs/history/` and `archive/` before the public push; `private-history` stays unpushed |
| `DESKD_*` env vars break an existing setup | One-release fallback to old names with a deprecation warning |

## 14. Out of scope

- Renaming the on-device `tb*` identifiers (§11)
- New features in the UI or daemon (the restructure is the prerequisite for working on them robustly)
- Android host maintenance
- Supporting other tablets

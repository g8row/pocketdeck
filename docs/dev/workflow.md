# Day-to-day workflow

Everything goes through `./pd` (run `./pd help`). The tablet is reachable at `root@172.16.42.1` over the USB
network once Linux runs; `pd ssh` / `tools/tb.sh` put `/usr/local/sbin` (tb-reboot, tbstate, wifi-up) on PATH.

| You want to… | Do |
|---|---|
| See what the tablet runs | `pd state` (kernel, slot, boot record, installed builds, UI service) |
| Change the UI | edit `pocketjs/apps/desk/*.tsx` with `pd deckd` running: rebuild + push in ~2 s |
| Change a deck tile | Deck Studio (http://127.0.0.1:7778/) or `deckd/config.ts` + restart deckd |
| Change the UI host (Rust) | `pd deploy` (rebuilds `pocketjs-kiosk` and the bundle, restarts `pocketdeck-ui`) |
| Try a kernel without installing | `pd build kernel && pd ramboot` (nothing written; next normal boot = installed system) |
| Install a kernel/root | `pd install kernel rootfs` → inactive slot; `pd slot <x> && pd reboot linux`; check `pd state` |
| Only the WiFi driver compiles? | `pd build wcn` (fast; shares the kernel build volume) |
| Read logs | `pd log ui`, `pd log kernel`, `pd log deckd` |
| Internet for `apk` without WiFi | `tools/tablet-net.sh` (proxy on the host + `ssh -R`) |
| Go to Android and back | `pd reboot android` … `pd reboot linux` (from Android it uses `linux-test.sh to-linux`) |
| Run tests | `cd deckd && bun test`; `cd pocketjs && bun test`; `cd pocketjs/hosts/android && cargo test` |
| Frame stats | `POCKETJS_STATS=1` (per second) or `2` (per frame) in `/etc/conf.d/pocketdeck-ui`; `swipe /dev/input/event2 l 10 400` injects swipes |
| Screenshot | Deck Studio's tablet view (deckd asks the UI host for its DRM front buffer); `tools/fb2png.py` only reads fbdev |

## Rules that keep the tablet out of BROM

- **Wait for `healthy`** (60 s after stage 2 starts) before the next test reboot. Three Linux boots in a row without
  it → `tbrescue` → Android. `pd state` shows `attempts`; `pd slot <x>` re-arms.
- **Never write the running slot.** `pd install` defaults to the other one; the running slot is your fallback.
- **Anything LK boots directly** (`boot`) must pass `device/analysis/lk_image_check.py`. `pd flash uboot` runs it.
- **Leave Android only through `pd reboot` / `tools/linux-test.sh`** (Magisk boot counter).
- **Never write `para`, `lk`, `preloader`, `seccfg`, `nvram`, `nvdata`, `protect1/2`.**
- `reboot -f` can hang: `tb-reboot` uses sysrq. Don't read `/sys/kernel/debug/clk/clk_summary` (locks up the SoC).
- One hypothesis per flash; know the way back before writing anything ([install/recovery.md](../install/recovery.md)).

More of these, with the reasons: [lessons.md](lessons.md).

## Where things are

| Path | What |
|---|---|
| `device/dts/`, `device/patches/` | board DTS, kernel patches (numbered, idempotent `.sh` + `.patch`), config fragment |
| `device/u-boot/` | U-Boot board code, `boot.cmd`, `tbstate` format, patches |
| `device/initramfs/` | stage 1: `init`, boot menu, `tbstate` tool |
| `device/rootfs/` | `build-rootfs.sh`, overlay (OpenRC services, `tb-reboot`, `wifi-up`), small C tools |
| `device/wcn/`, `device/wcn-tools/` | MT6625L WiFi/BT driver (out of tree) and its userspace |
| `device/gpu/` | Mesa (Panfrost) cross-build |
| `device/build/` | Docker build: `build.sh` (host), `build-in-docker.sh` (inside), `Dockerfile` |
| `device/analysis/` | LK checks and disassembly helpers, `fb_send.py` (LK fastboot), `memtest.c` |
| `tools/` | host scripts behind `pd` |
| `deckd/` | the host daemon, Deck Studio (`ui/`), Claude Code hooks |
| `pocketjs/` | submodule: framework, `hosts/android` (also builds the Linux host), `apps/desk` (the deck UI) |

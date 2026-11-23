# desk-companion

**A 2017 Lenovo Tab 7 (TB-7304X) turned into a 60 fps desk display for a Mac**, with Claude Code
sessions, a stream-deck grid, Now Playing, Mac/tablet vitals and a focus timer.

The tablet now boots **mainline Linux** as its main system: U-Boot loads Alpine from the internal eMMC, and Android
stays one step away in `recovery`. It runs a tiny JSX UI framework
([PocketJS](https://github.com/g8row/pocketjs/tree/android-host)) as its home screen and talks to a Bun daemon on the
Mac over USB. Saving a UI file on the Mac hot-reloads the tablet in about 2 seconds.

| | |
|---|---|
| ![home](docs/screenshots/home.png) | ![claude](docs/screenshots/claude.png) |
| **HOME**: clock, ASCII ridge field, glance row | **CLAUDE**: live sessions, tokens, context, tool timeline, quick actions |
| ![permission](docs/screenshots/permission.png) | ![board](docs/screenshots/board.png) |
| **Alerts**: a session needs you; allow/deny from the tablet | **BOARD**: every live number in one cell grid |
| ![pulse](docs/screenshots/pulse.png) | ![deck](docs/screenshots/deck.png) |
| **PULSE**: today's Claude usage, by hour and project | **DECK**: tappable actions that run on the Mac |
| ![focus](docs/screenshots/focus-running.png) | ![system](docs/screenshots/system.png) |
| **FOCUS**: a timer whose shape fans out as time runs down | **SYSTEM**: frame-time graph against the 16.7 ms budget, plus a spec table |

The panes and deck tiles are configured in **Desk Studio**, a small web app that deskd serves on localhost:

![desk studio](docs/screenshots/studio.png)

## How it fits together

```
 Mac                                                   Tablet (mainline Linux, Alpine)
┌──────────────────────────────────────┐   USB     ┌───────────────────────────────────────┐
│ deskd  (Bun)                         │  network  │ PocketJS kiosk (Rust/musl)            │
│  ├ providers: clock, CPU/RAM, Music, │  ssh -R   │  ├ link: TCP client, JSON lines       │
│  │  Claude sessions, usage, tablet   │◀────────▶ │  ├ QuickJS runs the Desk app (TSX)    │
│  ├ actions: shell, AppleScript, URL  │ tcp:7777  │  └ DRM/KMS scanout, 1024×600          │
│  ├ watches apps/desk → rebuild+push  │           └───────────────────────────────────────┘
│  └ :7778  Claude hooks + Desk Studio │
└──────────────────────────────────────┘
      ▲ HTTP POST from Claude Code hooks
```

- **[deskd/](deskd/README.md)**: the daemon on the Mac or Linux PC (state providers, tile actions, hot reload, Claude hooks, Desk Studio).
- **[pocketjs](https://github.com/g8row/pocketjs/tree/android-host)** (git submodule, branch `android-host`) contains:
  - `hosts/android`: the Rust host; on mainline it builds the musl `pocketjs-kiosk` binary that draws through DRM/KMS
    (on Android it draws to the framebuffer);
  - `apps/desk`: the Desk app itself.
- **[debloat/](debloat/README.md)**: a Magisk module that removes Google, Lenovo and MTK bloat systemlessly and applies a performance profile.
- **[kiosk/](kiosk/README.md)**: an optional mode that stops the Android framework entirely and draws straight to the framebuffer.
- **[device/](device/README.md)**: mainline Linux on MT6737M. It is the tablet's main system; current support,
  measurements and the ordered todo list are in [docs/hardware/status.md](docs/hardware/status.md).
- **[docs/ONBOARDING.md](docs/ONBOARDING.md)**: the full setup, from a stock tablet to a working desk.
- [LOG.md](LOG.md): the build log, with measurements and dead ends. [PLAN-overnight.md](PLAN-overnight.md) is the original plan.

## Numbers (measured on the device)

| | Stock | Android (then) | mainline Linux (now) |
|---|---|---|---|
| Installed packages | 124 | 45 | 92 |
| Free RAM, idle | ~310 MB | ~500 MB | ~714 MB available |
| Free RAM, kiosk mode | — | ~705 MB | — |
| Desk app frame cost | — | 2.6–5.6 ms mean per pane, 60 fps | not re-measured |
| Worst frame (demo app) | 18–49 ms | ~6 ms (4 cores pinned online, 858 MHz floor) | not re-measured |

The GPU (Mali-T720 through wgpu's GLES backend) works, but it ran ~4× slower than the damage-tracked software
renderer (45.5 ms vs 10.7 ms). It stays behind a build flag; see [LOG.md](LOG.md).

## Quick start (tablet already set up)

```bash
git clone --recurse-submodules https://github.com/g8row/desk-companion
cd desk-companion/deskd && bun main.ts        # USB: adb (Android) or DESKD_SSH (mainline)
open http://127.0.0.1:7778/                   # Desk Studio
```

Starting from a stock tablet? Follow **[docs/ONBOARDING.md](docs/ONBOARDING.md)**.

> ⚠️ Unlocking and rooting writes to the tablet's flash. Back up every partition first (the onboarding shows how).
> Your backup includes device-unique data (IMEI/nvram). **Never commit it.** `.gitignore` already excludes `backup/`.

## Status

The following work on the real device:
- mainline Linux as the default boot, with Android + Magisk in `recovery`;
- rooting and debloat;
- the desk app with hot reload, all 8 panes, deck actions and Claude hooks;
- Desk Studio;
- the PocketJS kiosk on mainline DRM/KMS, and Android kiosk mode.

Not done or not verified:
- Approving permission prompts from the tablet is built (`deskd/hooks/claude-gate.sh`), but the hook is not installed by default.
- Bluetooth is WIP: the controller powers on, but scans return nothing (see `docs/hardware/status.md`).
- The A/B update path for the inactive Linux slot is not written yet; slot B is empty.
- Audio, camera and modem are not planned.

## Credits

- [PocketJS](https://github.com/zerob13/pocketjs) by Yifeng "Evan" Wang (MIT), extended in the fork.
- [mtkclient](https://github.com/bkerler/mtkclient) and [Magisk](https://github.com/topjohnwu/Magisk) for unlocking and rooting.
- [Geist](https://vercel.com/font) fonts (OFL).
- The [mt6735-mainline](https://gitlab.com/mt6735-mainline/linux) kernel tree.

Built over one night of pair work with Claude Code. Licensed [MIT](LICENSE).

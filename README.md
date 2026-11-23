# PocketDeck

**A 2017 Lenovo Tab 7 (TB-7304X, MT6737M) turned into a 60 fps desk display**: Claude Code sessions, a stream-deck
grid, Now Playing, host and tablet vitals and a focus timer. It runs mainline Linux, and saving a UI file on the
host hot-reloads the tablet in about 2 seconds.

| | |
|---|---|
| ![home](docs/assets/screenshots/home.png) | ![claude](docs/assets/screenshots/claude.png) |
| **HOME**: clock, ASCII ridge field, glance row | **CLAUDE**: live sessions, tokens, context, tool timeline, quick actions |
| ![permission](docs/assets/screenshots/permission.png) | ![board](docs/assets/screenshots/board.png) |
| **Alerts**: a session needs you; allow/deny from the tablet | **BOARD**: every live number in one cell grid |
| ![pulse](docs/assets/screenshots/pulse.png) | ![deck](docs/assets/screenshots/deck.png) |
| **PULSE**: today's Claude usage, by hour and project | **DECK**: tappable actions that run on the host |
| ![focus](docs/assets/screenshots/focus-running.png) | ![system](docs/assets/screenshots/system.png) |
| **FOCUS**: a timer whose shape fans out as time runs down | **SYSTEM**: frame-time graph against the 16.7 ms budget |

Panes and tiles are configured in **Deck Studio**, a small web app deckd serves on localhost.

## From a stock tablet

| Stage | | Command | Doc |
|---|---|---|---|
| 0 | Host ready | `./pd doctor` | [prerequisites](docs/install/00-prerequisites.md) |
| 1 | Back up, unlock, root | mtkclient, Magisk | [backup-unlock-root](docs/install/01-backup-unlock-root.md) |
| 2 | Repartition | `tools/tb-gpt.py` | [repartition](docs/install/02-repartition.md) |
| 3 | U-Boot in `boot`, Android in `recovery` | `./pd flash uboot` | [uboot](docs/install/03-uboot.md) |
| 4 | Linux on the eMMC | `./pd build all`, `./pd install kernel rootfs` | [linux](docs/install/04-linux.md) |
| 5 | PocketDeck | `./pd deploy`, `./pd deckd` | [pocketdeck](docs/install/05-pocketdeck.md) |
| – | Something broke | `./pd state`, `./pd slot a`, `./pd reboot android` | [recovery](docs/install/recovery.md) |

> Stages 1–3 write the tablet's flash; read [recovery.md](docs/install/recovery.md) first. Your partition dump
> contains device-unique data (IMEI/NVRAM): **never commit or publish `backup/`.**

## How it fits together

```
 Host (Linux or macOS)                                 Tablet (Linux 7.0, Alpine)
┌──────────────────────────────────────┐   USB     ┌───────────────────────────────────────┐
│ deckd  (Bun)                         │  network  │ pocketdeck-ui: PocketJS Linux host    │
│  ├ providers: clock, CPU/RAM, music, │  ssh -R   │  (Rust/musl, DRM/KMS, 1024×600 @60)   │
│  │  Claude sessions, usage, tablet   │◀────────▶ │  ├ link: TCP client, JSON lines       │
│  ├ actions: shell, app, URL, …       │ tcp:7777  │  └ QuickJS runs the deck app (TSX)    │
│  ├ watches the app → rebuild + push  │           └───────────────────────────────────────┘
│  └ :7778  Claude hooks + Deck Studio │            LK → U-Boot → Linux (slots A/B), Android in recovery
└──────────────────────────────────────┘
      ▲ HTTP POST from Claude Code hooks
```

| Path | What |
|---|---|
| [`pd`](pd) | the command line: build, install, deploy, state, reboot, recovery helpers |
| [`device/`](docs/dev/workflow.md#where-things-are) | everything flashed to the tablet: DTS, kernel patches, WiFi driver, U-Boot, initramfs, rootfs, Mesa |
| [`deckd/`](deckd/README.md) | the host daemon, Deck Studio, Claude Code hooks |
| [`pocketjs/`](https://github.com/g8row/pocketjs/tree/android-host) | submodule: the UI framework, the host (`hosts/android` also builds the Linux binary), the deck app (`apps/desk`) |
| [`tools/`](tools) | host scripts behind `pd` |
| [`docs/`](docs/index.md) | install path, architecture, hardware status and research, dev notes |
| [`archive/android/`](archive/android/README.md) | the Android era (its debloat module is still needed for the rollback Android) |

## Status

Works on the device: display (mediatek-drm, 60 Hz), touch, buttons, 4 cores with cpufreq, GPU (Panfrost), eMMC,
USB networking, WiFi, charger/battery/RTC/thermal, accelerometer; the boot chain with slots, boot counter, boot menu
and Android rollback; the deck UI with hot reload, all panes, deck actions and Claude hooks; Deck Studio.

Open: Bluetooth (powers on, scans find nothing), hardware display planes, GPU frequency scaling; approving
permission prompts from the tablet is built but experimental. Audio, camera and modem are not planned.
Details: [docs/hardware/status.md](docs/hardware/status.md).

## Credits

- [PocketJS](https://github.com/zerob13/pocketjs) by Yifeng "Evan" Wang (MIT), extended in the fork.
- The [mt6735-mainline](https://gitlab.com/mt6735-mainline/linux) kernel and U-Boot trees, and postmarketOS.
- [mtkclient](https://github.com/bkerler/mtkclient) and [Magisk](https://github.com/topjohnwu/Magisk).
- [Geist](https://vercel.com/font) fonts (OFL).

Built in pair work with Claude Code. Licensed [MIT](LICENSE). History before the rename: tag `android-era-final`.

# UI redesign: plan and plumbing briefs

Status (2026-11-23): groundwork done on pocketjs branch `feat/desk-damage-layout`; six page agents redesign BOARD,
DECK, CLAUDE, USAGE, MUSIC and SETTINGS against mock data, one worktree each (`.worktrees/<page>`, branches
`feat/desk-<page>`). Design rules and the page contract: `pocketjs/apps/desk/DESIGN.md`. Plumbing (below) starts
once the pages are approved.

## Decisions

- The panel's damaged left strip (x < 106) is the rail: clock, date, Claude status, battery, an ASCII sound wave.
- Mixed style: read-only content in terminal frames, touchable controls rounded; single-colour Nerd Font icons
  (GeistMono Nerd Font in the mono slot), no emoji.
- Tabs: BOARD (overview, HOME merged in) · DECK · CLAUDE · USAGE (PULSE redone) · MUSIC · SETTINGS (replaces SYSTEM).
  FOCUS is off.
- The host is named by its OS ("linux cpu"), never "mac".
- MUSIC: real cover art, shapes as fallback; prev/play/next, shuffle, repeat, volume, seek.
- SETTINGS runs on the tablet itself (works without a computer); destructive actions use a confirm sheet that
  pauses the ghost-touch filters; display dimming follows the host's lock/sleep state.
- BOARD keeps a 1m / 10m / 1h history switch.

## Integration (after the page agents)

1. Review each page's screenshots with the user; iterate per page (SendMessage to its agent).
2. Merge `feat/desk-<page>` into `feat/desk-damage-layout` (pages touch disjoint files; mocks are per page).
3. Add the icons the agents asked for to `nf.ts` (check each codepoint against the font, see nf.ts header).
4. Delete the old page code: `pages.tsx`, `views.tsx`, `deck.tsx`, `claude.tsx`, `ridges.tsx` (once nothing
   imports them), `kit-test.tsx` (or keep as a doc page), the `focus` provider stays in deckd for deck tiles.
5. `pd deploy`, capture all six panes on the tablet (`kill -USR1` front-buffer dump), compare with the previews.
6. Plumbing round (below), then a device pass: every control on the tablet.

## Plumbing brief A: deckd data and actions (main repo `deckd/`)

The page contract is `pocketjs/apps/desk/DESIGN.md` §5 (fields marked NEW) and `preview/mock.json` (exact shapes).

| Item | Linux | macOS |
|---|---|---|
| `host` provider `{ os, name, screen }` | `os: "linux"`, `name: os.hostname()`, `screen` from logind (`LockedHint` / idle hint via `platform/dbus.ts`; "asleep" when the display is off/DPMS) | `os: "macos"`, screen locked via `CGSessionCopyCurrentDictionary`-equivalent (`ioreg`/`pmset` is fine) |
| `sys.cores`, `sys.ghz`, `memUsedGb`, `memTotalGb` | `os.cpus()`, `/proc/meminfo` | `os.cpus()`, `vm_stat` (platform already has memPercent) |
| `sys.hist.{cpu,mem}.{1m,10m,1h}` | sample every 2 s; 1m = last 30 samples; 10m = 30 × 20 s means; 1h = 30 × 2 min means | same |
| `tablet.tempC`, `volts`, `currentMa` | add to `LINUX_SCRIPT` in `providers/tablet.ts`: `power_supply/battery/{temp (0.1 °C), voltage_now (µV), current_now (µA)}`; `mode: "linux"` instead of "mainline" (keep parsing both) | — |
| `usage.days[7]` `{ d, out }` | extend `providers/usage.ts` to scan the last 7 days of transcripts (already per-day internally) | same |
| `music.player`, `shuffle`, `repeat`, `volume` | `providers/mpris.ts`: `Identity` (or bus-name suffix), `Shuffle`, `LoopStatus` (None/Playlist/Track → off/all/one), `Volume` (0–1 → 0–100) | AppleScript: `shuffle enabled`, `song repeat`, `sound volume` of Music; player "music" |
| actions `music.shuffle`, `music.repeat`, `music.seek {pos}`, `music.volume {v}` | MPRIS set-property `Shuffle`, `LoopStatus` (cycle), `SetPosition(trackid, µs)`, `Volume` | AppleScript `set shuffle enabled`, `set song repeat`, `set player position`, `set sound volume` |
| `sys.window {w}` | accept and ignore (the tablet picks the window; all windows are sent) | same |
| Deck Studio | pane ids `board, deck, claude, usage, music, settings`; migrate saved layouts with old ids (home → board; drop pulse/focus/system) | same |

Tests: extend `deckd/test/` (parse functions, history downsampling, layout migration). The data must not leak host
paths or names beyond `host.name`.

## Plumbing brief B: the tablet command channel (pocketjs `hosts/android`, Rust)

Contract: `pocketjs/apps/desk/device.ts` header. Mount a `device` global the way `link` is mounted
(`src/link.rs`, `guest.mount("link", …)`):

- `device.read("state")` returns the `DeviceState` JSON, served from a cache that a background thread refreshes
  every ~2 s: backlight (`/sys/class/backlight/backlight/{brightness,max_brightness}`), WiFi (`iw dev mt6625_0 link`,
  `ip -4 addr`), battery (`power_supply/battery`, charger `sm5414-charger` CV for `chargeLimit`), boot slot
  (`tb.slot=` on `/proc/cmdline`, `tbstate` for `last_good_slot`), build (`/data/pocketdeck/slot-<x>.kernel`
  `version=`), `uname -r`, uptime, `thermal_zone0`, cpufreq, meminfo, and the persisted settings below.
- `device.run(cmd, args)`: a fixed whitelist, arguments validated, no shell string building:
  `reboot {target}` → `tb-reboot <target>` (detached), `poweroff`, `restart-ui` → detached
  `rc-service pocketdeck-ui restart`, `brightness {value}` → sysfs write, `wifi {on}` → `wifi-up join` / `wifi-up off`
  (async), `charge-limit {on}` → SM5414 constant charge voltage 4.10 V / 4.35 V, `dim-follow-host {on}` → persist,
  `touch-filters {paused}` → a shared flag the `Touch` filter code in `src/kiosk.rs` honours, with a 60 s safety
  timeout that unpauses on its own.
- Persist settings (`dimFollowHost`, `chargeLimit`, last brightness) in `/data/pocketdeck/settings.json`; apply them
  at start.
- Dimming that follows the host lives in the app (it sees `desk.host.screen`): when locked → brightness ~10 %,
  asleep → 0, active → the saved brightness; only while `dimFollowHost`.
- Rust unit tests for the argument validation and the state parsing; then deploy (`pd deploy`) and exercise every
  command on the tablet (reboots last, one at a time, waiting for `healthy`).

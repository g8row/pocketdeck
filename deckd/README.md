# deskd

The computer half of the desk companion, for **macOS or Linux**. It is a single Bun process with no npm dependencies.
Everything OS-specific lives in `platform/` (`darwin.ts`, `linux.ts`); how the tablet is reached lives in `transport.ts`.

```bash
bun main.ts        # run
bun test           # unit tests (protocol, config, runner, gate, transcript, usage, focus)
```

## What it does

| | |
|---|---|
| **Link** | A TCP server on `127.0.0.1:7777`. Every 3 s it re-applies `adb reverse tcp:7777 tcp:7777` (Android tablet) and keeps an `ssh -R 7777:127.0.0.1:7777` tunnel to `DESKD_SSH` (mainline Alpine tablet over USB networking). Either way the tablet dials its own `127.0.0.1:7777`, and replugging just works. |
| **Hot reload** | Watches `../pocketjs/apps/desk/`. On save it runs `bun pocket compile --target android` and pushes the bundle (JS + font/texture pak) to the tablet, which swaps it in place (~2 s end to end). |
| **Providers** | Push state keys to the tablet (see below). |
| **Actions** | Tile taps arrive as `{t:"action", id}` and run on the Mac. |
| **Claude hooks** | `POST 127.0.0.1:7778/claude` receives Claude Code hook events. |
| **Permission gate** | `POST 127.0.0.1:7778/claude/permission` holds a permission request for up to ~25 s for an allow/deny tap on the tablet. Otherwise it returns empty and the normal prompt appears. |
| **Desk Studio** | `http://127.0.0.1:7778/`: a web UI for panes, deck tiles and accent. It saves to `desk.config.json` and hot-pushes. |

## Providers

| Key | Source | Interval |
|---|---|---|
| `clock` | local time | 1 s |
| `sys` | host CPU and memory (`vm_stat` / `/proc/meminfo`) | 2 s |
| `music` + art blob | macOS: Apple Music via AppleScript. Linux: any MPRIS player (`busctl`), art scaled with ImageMagick. Pushed as an RGBA blob | 1 s |
| `deck` | tiles + live subtitles from `config.ts` / `desk.config.json` | 5 s |
| `claude` | hook events + transcript tail (`providers/transcript.ts`): model, tokens, context, tool timeline | 1–3 s |
| `usage` | today's Claude usage from `~/.claude/projects/**/*.jsonl` | 30 s |
| `focus` | the focus timer (state lives in deskd) | 1 s |
| `tablet` | battery, free RAM, CPU clock, uptime via `adb shell` or the ssh connection | 30 s |

## Linux

```bash
deskd/linux/install.sh      # systemd user service, starts with the graphical session
journalctl --user -u deskd -f
```

What the builtins use (each is looked up at run time; a missing tool makes that tile a no-op):

| Builtin | Linux |
|---|---|
| volume, mic | `wpctl` (PipeWire), else `pactl`, else `amixer` |
| music, transport | MPRIS over `busctl --user` (playing player first); art via `magick`/`convert` |
| caffeine | `org.freedesktop.ScreenSaver.Inhibit` (or GNOME's SessionManager) on a D-Bus connection deskd holds (`platform/dbus.ts`), plus `systemd-inhibit --what=idle:sleep`. Released when toggled off or deskd exits |
| lock | `loginctl lock-session` on the graphical session, else ScreenSaver.Lock |
| display sleep | KDE `kscreen-doctor --dpms off`, GNOME Mutter `PowerSaveMode`, `wlopm`, `xset dpms force off` |
| screenshot | `spectacle`, `gnome-screenshot`, `grim`, `maim`, `scrot`, `import` → Desktop or Pictures |
| terminal | `$TERMINAL`, the desktop's own, `x-terminal-emulator`, then common ones (cwd flags per terminal) |
| Claude | a Claude desktop build if installed, else raise a window titled `✳ …` (KWin), else a terminal running `claude` |
| CLAUDE pane: editor / folder / copy / focus | `claude.editor` mapped to a command (`Visual Studio Code` → `code`, `Zed` → `zeditor`…), `xdg-open`, `wl-copy`/`xclip`, KWin window runner or `wmctrl` |
| notifications, sound | `notify-send` or `org.freedesktop.Notifications` via `gdbus`; `pw-play`/`paplay` |
| "open app" tiles | the app's `.desktop` entry by Name or id (`gio launch`, `gtk-launch`, `kioclient`), else run as a command |

Desk Studio hides the AppleScript and Shortcut action types on Linux. Its tablet screenshot works over ssh too:
deskd asks the mainline kiosk to dump its DRM front buffer (SIGUSR1, only if the running binary supports it), else
reads `/dev/fb0`, and rotates the portrait panel to landscape.

## Configuration

- **`config.ts`** holds the built-in tiles and actions (mic toggle, volume, Terminal, Claude, screenshot) and their
  live subtitles. It is TypeScript, so a tile can compute anything.
- **`desk.config.json`** is written by Desk Studio and is git-ignored. It stores the pane order and visibility, extra
  deck tiles and the accent colour. Tile actions are one of these types: `shell`, `url`, `app`, `applescript`,
  `shortcut` or `builtin` (see `runner.ts`). AppleScript and Shortcuts need macOS; the others also work on Linux
  (and, untested, Windows). Every child process gets a timeout and its output is discarded.

Environment variables:

| Var | Default |
|---|---|
| `DESKD_PORT` | `7777` (tablet link) |
| `DESKD_HOOK_PORT` | `7778` (hooks + Desk Studio) |
| `DESKD_CONFIG` | `deskd/desk.config.json` |
| `POCKETJS_DIR` | `../pocketjs` |
| `DESKD_SSH` | `root@172.16.42.1`: ssh target of a mainline tablet (an `~/.ssh/config` alias works; key auth only; `off` disables) |

## Wire protocol (`protocol.ts`)

There is one JSON object per line in each direction. The other end is `pocketjs/hosts/android/src/link.rs`.

```ts
// Mac → tablet
{ t: "state",  k, v }                         // a state key changed
{ t: "blob",   k, w, h, b64 }                 // RGBA image (album art)
{ t: "bundle", js, pak, viewport? }           // new app bundle → hot reload
// tablet → Mac
{ t: "hello",  host, abi, bundle, viewport }  // bundle = FNV-1a hash; deskd skips the push if it matches
{ t: "action", id, args? }
{ t: "reloaded", ok, error? }
{ t: "error",  error }
```

## Security

Both servers bind to `127.0.0.1` only. Desk Studio's API needs a per-run token that deskd injects into the page it
serves, and requests with a foreign `Host` header are rejected. This guards against DNS rebinding and CSRF from
websites open in your browser.

## Hooks

- `hooks/claude-hook.sh` forwards the hook's stdin JSON with a 1 s timeout and always exits 0.
- `hooks/claude-gate.sh` is the `PermissionRequest` hook for approving from the tablet. It is experimental and not
  installed by default.

Install instructions are in [docs/ONBOARDING.md](../docs/ONBOARDING.md#6-claude-code-hooks-optional-but-the-claude-pane-needs-them).

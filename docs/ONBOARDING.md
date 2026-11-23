# Onboarding: from a stock TB-7304X to a working desk

This takes you from a factory tablet to the desk companion running, and then explains the dev loop.
Allow about an hour for parts 1–3 and 15 minutes for the rest.

> **The current system is mainline Linux**, not Android: U-Boot boots Alpine from the internal eMMC by default and
> Android + Magisk stay in `recovery`. This guide covers the Android setup (rooting, debloat, kiosk) and the
> rollback path; the Linux bring-up, install and day-to-day flow are in
> [docs/hardware/status.md](device/STATUS.md) and [device/README.md](../mainline/README.md).

**You need:**
- a Mac (Apple Silicon or Intel);
- a Lenovo Tab 7 **TB-7304X** (MT6737M; other TB-7304 variants are untested);
- a USB cable that carries data.

In the Android setup below, everything after rooting runs over `adb`. On mainline the same desk runs over the USB
network and `ssh` (`DESKD_SSH`).

> ⚠️ Parts 1–2 write to the tablet's flash. They worked on our unit, but you do them at your own risk.
> Always take the full backup first.

---

## 0. Mac prerequisites

```bash
brew install android-platform-tools android-commandlinetools python@3.12
curl -fsSL https://bun.sh/install | bash               # Bun ≥ 1.1
curl https://sh.rustup.rs -sSf | sh                     # Rust (stable)
rustup target add aarch64-linux-android
cargo install cargo-ndk
sdkmanager "ndk;27.2.12479018" "build-tools;34.0.0" "platforms;android-24"
xcode-select --install                                  # libclang for bindgen
```

`pocketjs/hosts/android/build.sh` expects `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`.
If your SDK is somewhere else, override `ANDROID_HOME`, `NDK_VER`, `BT_VER` and `LIBCLANG_PATH`.

Clone the repo with its submodule:

```bash
git clone --recurse-submodules https://github.com/g8row/desk-companion
cd desk-companion
```

## 1. Back up everything, then unlock the bootloader (mtkclient)

[mtkclient](https://github.com/bkerler/mtkclient) talks to the MediaTek BootROM, so it works on a locked bootloader.

```bash
git clone https://github.com/bkerler/mtkclient tools/mtkclient
python3 -m venv tools/venv && tools/venv/bin/pip install -r tools/mtkclient/requirements.txt
cd tools/mtkclient
```

To put the tablet in **BROM mode**, power it off, hold **Vol+ and Vol−**, and plug in USB. mtkclient prints
`Waiting for PreLoader VCOM` until it sees the device.

```bash
# 1. full partition dump (~4.6 GB incl. system, nvram/IMEI, lk, boot, recovery)
../venv/bin/python mtk rl ../../backup/partitions
# 2. unlock (rewrites seccfg; on our unit userdata was NOT wiped)
../venv/bin/python mtk da seccfg unlock
```

Keep `backup/partitions/` somewhere safe, and **never publish it**: `nvram`/`nvdata` hold your IMEI.

## 2. Root with Magisk

1. Download the Magisk APK (we used v31.1) from its GitHub releases.
2. Patch the stock `boot.bin` on the Mac. Unzip the APK; its `assets/boot_patch.sh` plus the `lib/arm64-v8a/lib*.so`
   tools (renamed to `magiskboot`, `magiskinit` and so on) can patch a boot image. Alternatively, install the APK on the
   tablet, patch there with *Install → Select and patch a file*, and pull the result.
3. Write the patched image to `boot` (BROM mode again):

   ```bash
   ../venv/bin/python mtk w boot ../magisk/magisk-boot.img
   ```

4. Boot, install the Magisk APK (`adb install Magisk-v31.1.apk`), open it once, and allow root for the shell.
   `adb shell su -c id` should print `uid=0`.

## 3. Debloat and tune (Magisk module)

```bash
adb push debloat/module /data/local/tmp/tb7304x_strip
adb shell su -c 'cp -r /data/local/tmp/tb7304x_strip /data/adb/modules/ && chmod 755 /data/adb/modules/tb7304x_strip/service.sh'
adb reboot
```

The module systemlessly hides about 80 system apps (Google services, Lenovo apps, MTK test tools) and its `service.sh`
sets a desk-display profile at boot. [debloat/README.md](../debloat/README.md) lists all of it.
To undo, delete `/data/adb/modules/tb7304x_strip` and reboot.

After the reboot, check that boot completed and nothing crashed:

```bash
adb shell getprop sys.boot_completed           # 1
adb logcat -b crash -d | head                  # empty
```

## 4. Build and install the tablet app

```bash
cd pocketjs && bun install
hosts/android/build.sh                          # → hosts/android/out/pocketjs.apk
adb install -r hosts/android/out/pocketjs.apk
```

The APK (`dev.pocketjs.shell`) declares itself a HOME app. The module hides the Lenovo launcher, so pressing
Home now opens PocketJS. You only rebuild the APK when the **Rust host** changes. Desk app (TSX) changes are
hot-pushed by deskd.

## 5. Run deskd on the Mac

```bash
cd deskd && bun main.ts
```

deskd:
- runs `adb reverse tcp:7777 tcp:7777` every 3 s, so replugging USB just works;
- builds the Desk app and pushes the bundle when the tablet connects;
- serves **Desk Studio** at <http://127.0.0.1:7778/> for panes, deck tiles and accent colour.

The header dot on the tablet turns on when the link is up. **Now Playing** reads Apple Music through AppleScript.
macOS may ask once to allow automation of Music.

## 6. Claude Code hooks (optional, but the CLAUDE pane needs them)

Add this to `~/.claude/settings.json`. Back the file up first and merge it into any existing `hooks` block.
Use the absolute path to your clone:

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/desk-companion/deskd/hooks/claude-hook.sh", "timeout": 3 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/desk-companion/deskd/hooks/claude-hook.sh", "timeout": 3 }] }],
    "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/desk-companion/deskd/hooks/claude-hook.sh", "timeout": 3 }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/desk-companion/deskd/hooks/claude-hook.sh", "timeout": 3 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/desk-companion/deskd/hooks/claude-hook.sh", "timeout": 3 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "/ABS/PATH/desk-companion/deskd/hooks/claude-hook.sh", "timeout": 3 }] }]
  }
}
```

The hook POSTs the event JSON to deskd with a 1 s timeout and always exits 0, so it never slows or breaks a session.

**Approve from the tablet (experimental):**
- Register `deskd/hooks/claude-gate.sh` as a `PermissionRequest` hook (timeout ≥ 30).
- deskd holds the request for up to ~25 s while you tap allow or deny.
- With no tablet, no answer, or deskd down, it prints nothing and Claude Code shows its normal prompt.

## 7. Day-to-day dev loop

| You want to… | Do this |
|---|---|
| Change the UI | Edit `pocketjs/apps/desk/*.tsx` and save. The tablet reloads in ~2 s; deskd logs the rebuild. |
| Add or change a deck action | Use Desk Studio, or edit `deskd/config.ts` (built-ins) and restart deskd. |
| Change the Rust host | Run `pocketjs/hosts/android/build.sh && adb install -r …/pocketjs.apk`. |
| See frame cost | Run `adb logcat -s pocketjs:V \| grep "tick cost"`. Keep the mean under ~5 ms. |
| Screenshot the tablet | Run `adb exec-out screencap -p > shot.png`. |
| Run tests | Run `cd deskd && bun test`, `cd pocketjs && bun test`, and `cd pocketjs/hosts/android && cargo test`. |

**PocketJS gotchas** that will bite you:
- Class strings must be **full literals**, never template-interpolated. Ternaries of literals are fine.
- Font sizes are limited to 12/14/16/18/20/24/36 px. `font-bold` selects Geist Mono in this app.
- Glyphs are baked at build time from string literals (`apps/desk/charset.ts`). Runtime text with unseen characters renders blank.
- The core doesn't wrap text, so pre-wrap with `\n`.
- Animate paint-only props (translate, scale, rotate, opacity, arc sweep), never width or height.
- Pause animations on off-screen panes.
- Register `onFrame` hooks inside components, because `mount()` clears earlier ones.

## 8. Kiosk mode (optional)

Kiosk mode drops the whole Android framework and frees about 200 MB more RAM. See [kiosk/README.md](../kiosk/README.md).
The power button or `kiosk.sh stop` brings Android back.

> The tablet can also boot **mainline Linux** as its main system, with Android in `recovery`. That path uses the USB
> network and `ssh` instead of adb; see [device/README.md](../mainline/README.md) and
> [docs/hardware/status.md](device/STATUS.md). The rest of this guide describes the Android setup.

## Troubleshooting

- **Tablet shows "offline".**
  - Is deskd running? Check `adb devices`.
  - Check `adb reverse --list`; deskd re-applies the reverse every 3 s.
- **Blank text.** The characters aren't in the baked charset. Add them as a literal or extend `charset.ts`.
- **Jank.** Make sure the module's perf profile applied:
  - `cat /proc/hps/num_base_perf_serv` should print `4`;
  - `cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq` should print `858000`.
- **Boot loop after a module change.**
  - If adb is up during boot: `adb shell su -c 'touch /data/adb/modules/tb7304x_strip/disable'`, then reboot.
  - If it isn't: flash `backup/partitions/boot.bin` back with mtkclient (`mtk w boot …`).

## Repo map

```
deskd/            Mac daemon (Bun): main.ts, providers/, config.ts, deskconfig.ts, runner.ts, gate.ts, ui/ (Desk Studio), hooks/
pocketjs/         submodule, branch android-host: hosts/android (Rust host + kiosk), apps/desk (the UI)
debloat/          Magisk module + package lists
kiosk/            kiosk.sh and helpers (on device: /data/local/tmp/kiosk)
device/         mainline Linux (the current default system): DTS, patches, U-Boot, build scripts (images not committed)
backup/           package lists only; your partition dump lives here but is git-ignored
docs/             this guide + screenshots
```

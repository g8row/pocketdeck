# Stage 0 · Host prerequisites

Stage 0 of 5 · **you are here:** a host computer and a stock TB-7304X · **you need:** a Linux or macOS host, a data
USB cable · **you end with:** `pd doctor` green for the parts you will use
Next: [01 backup, unlock, root](01-backup-unlock-root.md) · If it fails: [recovery](recovery.md)

> Stages 1–3 write to the tablet's flash. They worked on our unit (TB-7304X, MT6737M); other TB-7304 variants are
> untested. Back up first, read [recovery.md](recovery.md) before you start, and expect to need BROM at least once.

## Clone

```sh
git clone --recurse-submodules https://github.com/g8row/pocketdeck
cd pocketdeck
cp .pd.env.example .pd.env      # optional: tablet address, remote build host
./pd doctor
```

## What each part needs

| For | Tools | Notes |
|---|---|---|
| Everything | git, ssh, rsync, python3 | `pd` is POSIX sh; run it from anywhere |
| Stage 1 (backup, unlock) | [mtkclient](https://github.com/bkerler/mtkclient) in `tools/mtkclient` + a venv in `tools/venv` | BROM access usually needs root or a udev rule |
| Stage 1 (root), rollback | adb | Android side only |
| LK fastboot (stages 2–3) | python3 + pyusb + libusb | `tools/fbusb` creates its own venv; the stock `fastboot` tool stalls against LK |
| U-Boot RAM boots | `fastboot` (platform-tools) | U-Boot's fastboot works with the stock tool |
| Kernel, U-Boot, rootfs, Mesa builds | Docker (arm64 native or x86_64 cross) | or a remote Docker host: `PD_BUILD_HOST` + `PD_BUILD_DIR` in `.pd.env` |
| UI (stage 5) | Bun ≥ 1.1, Rust + `aarch64-unknown-linux-musl`, Zig | `rustup target add aarch64-unknown-linux-musl`; Zig at `~/.local/opt/zig-*/zig` or `ZIG=` |
| deckd (stage 5) | Bun | Linux: systemd user session for the service; macOS works too |

## USB network

The tablet's Linux exposes a CDC-ECM gadget at **172.16.42.1** (host side 172.16.42.2/24, served by the tablet's
DHCP). Give the host's `enx*` interface its own NetworkManager profile with `never-default`, so the tablet never
becomes the host's default route. **Never run `nmcli d connect`** on it: it can move the host's main wired profile
onto the tablet link.

Next: [01 backup, unlock, root](01-backup-unlock-root.md)

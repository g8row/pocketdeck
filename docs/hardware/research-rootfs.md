# TB-7304X mainline: a root filesystem on the eMMC (research, 2026-11-16)

Research only. Nothing was run on the tablet and no repo file was changed. I read the build host (taos) only to check
for Docker and binfmt.

> **Current status (2026-11-19):** this is the 2026-11-16 research note. The RTC, charger, AUXADC and thermal
> drivers described as missing below are implemented; see [STATUS.md](STATUS.md). The live root is on `tbroot_a`.

> **Long-term layout decided 2026-11-17** in [plan-dualboot.md](plan-dualboot.md):
> - No microSD.
> - `userdata` shrinks to 3 GiB. Android's data is wiped once, and its stock recovery re-formats it so Android can
>   re-encrypt.
> - The freed space holds `tbstate`, raw kernel slots A/B/rescue, ext4 roots A/B and `tbdata`.
>
> The cache loop image below stays the interim root until the migration in plan-dualboot §6.

## TL;DR recommendation

- **Where:** an ext4 **loop image file on the `cache` partition** (`/cache/linux/rootfs.img`), inside Android's own
  cache filesystem. Nothing is repartitioned or reformatted. Android still mounts `/cache` normally and never looks
  inside the image. `userdata` cannot be used from Linux: it is **force-encrypted**. A microSD card is the clean
  long-term alternative, but it needs msdc1 DTS work first.
- **What:** **Alpine Linux 3.24 aarch64** (minirootfs 3.24.4 plus `apk`), with OpenRC, dropbear or openssh, and a
  static `usb0` at 172.16.42.1. It uses about 30–60 MB, so it fits comfortably in cache. Debian is too big for cache.
  postmarketOS (now **Nura**, nura.eco) would need a full device port, and its initramfs and cmdline don't fit the
  16 MiB recovery partition or LK's 99 characters.
- **How it boots:** our `init` stays as stage 1. It finds `cache` by GPT **PARTNAME** (no `root=` needed), mounts it,
  loop-mounts the image and `switch_root`s. If anything fails, it falls back to today's initramfs shell. A boot
  counter on cache protects against boot loops.
- **How to write it:** copy one file into `/cache/linux/` **from rooted Android** (adb push + `su cp`). The fallback is
  `nc` from the mainline initramfs. Neither writes a raw partition. `fastboot flash cache` is possible
  (max-download 128 MiB, sparse supported), but it replaces Android's cache filesystem, so it is not needed.

## 1. Partition layout

### What the repo proves
- Names (from the stock `fstab.mt6735` in the boot.bin and recovery.bin ramdisks, and LK strings):
  `proinfo, nvram, protect1, protect2, lk, para (misc/BCB), boot, recovery, logo, expdb, seccfg, oemkeystore, secro,
  keystore, tee1, tee2, frp, nvdata, metadata, flashinfo, system, cache, userdata`, plus modem/SCP blobs
  (`md1img`…, `scp1/2`, `odmdtbo`) that LK knows about. There is no `vendor` mount in fstab and no A/B slots, so
  there is **no second `system` slot**.
- Known sizes (from the backups): boot 16 MiB, recovery 16 MiB, lk 512 KiB, logo 8 MiB.
- The full GPT/size table is **not in the repo**. The mtkclient dump on the Mac (~4.6 GB, which suggests it excludes
  userdata) would have it.
- Typical MT6737 Android 7 16 GB layout (unverified): system ~2.5–3 GB, **cache ~256–450 MB**, userdata ~11–12 GB.
- Read-only ways to get the real table (pick one):
  - mainline initramfs:
    `mlsh.py 'for d in /sys/class/block/mmcblk0p*; do (. $d/uevent; echo $DEVNAME $PARTNAME $(($(cat $d/size)/2048))MiB); done'`
  - LK fastboot: `fb_send.py - getvar:partition-size:cache` (LK registers `partition-size:%s` and `partition-type:%s`)
  - Android:
    `adb shell su -c 'ls -l /dev/block/platform/mtk-msdc.0/11230000.msdc0/by-name; df -h /cache /data; getprop ro.crypto.state; getprop ro.crypto.type'`

### Encryption: userdata is force-encrypted (FDE)
Stock `fstab.mt6735` (identical in boot and recovery):
```
.../by-name/userdata /data ext4 noatime,nosuid,nodev,noauto_da_alloc,discard wait,check,resize,forceencrypt=.../by-name/metadata
.../by-name/cache    /cache ext4 noatime,nosuid,nodev,noauto_da_alloc,discard wait,check
```
`forceencrypt=` means Android 7 full-disk encryption (dm-crypt, crypt footer in `metadata`). The master key is wrapped
by keymaster in the TEE (microtrust, `init.microtrust.rc`). **Linux cannot decrypt it**, even with the default
password. Magisk does not change this by default. Confirm with `getprop ro.crypto.state` (expect `encrypted`) and
`ro.crypto.type` (`block`). So a loop file on userdata, or a shared userdata, is out. Reusing userdata means wiping it
and Android's data, and Android would then re-encrypt or complain.

### Options compared
| Option | Android impact | Effort | Verdict |
|---|---|---|---|
| **Loop image in `/cache/linux/` (ext4 file on the existing cache fs)** | None in practice. Android keeps mounting cache. Each boot it `chown/chmod`s the cache top dir and runs `restorecon_recursive /cache` (init.rc:287–299), which only relabels one image file | low | **recommended** |
| Rootfs as a plain directory `/cache/linux/` | Works, but `restorecon_recursive` rewrites xattrs on every file at each Android boot (slower boot), and the files are mixed into Android's fs | low | ok, second choice |
| Reformat all of `cache` as our rootfs (`fastboot flash cache`) | Android mounts `/cache` with `check`. A foreign fs or newer ext4 features (metadata_csum/64bit vs Android 7's old e2fsck) can break recovery/OTA logs, and Android writes into our root | low-medium | no |
| `userdata` | wipes Android data, FDE re-encrypts it | low | no (Android must stay usable) |
| Shrink userdata / new GPT entry | GPT edit plus wipe; the FDE fs can't be resized from outside | high, risky | no |
| `system` / second slot | no A/B, and system is Android's | — | no |
| **microSD (msdc1)** | zero | medium: enable msdc1 in DTS (MT6328 VMCH/VMC regulators, pinctrl, card-detect from stock DTB) | best long term: rewrite the card on a PC |

Tradeoffs of the recommendation:
- Size is capped by cache free space (check `df /cache`; plan an image of ~256 MB).
- A factory reset or "wipe cache" in stock recovery deletes it.
- Unclean shutdown: there is no e2fsck in the initramfs today (see stage 1).
- Write performance: double journalling (ext4 on loop on ext4), irrelevant at eMMC 50 MHz.

## 2. Distro choice

- **Alpine 3.24 (recommended).** The minirootfs is 4 MB (`alpine-minirootfs-3.24.4-aarch64.tar.gz`, sha256
  `4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de`, from dl-cdn latest-stable). It is musl +
  busybox + apk + OpenRC (via `alpine-base`), which is the same toolchain family pmOS uses. Base + openssh is ~30 MB.
  It needs no kernel support we don't already have: config has DEVTMPFS, CGROUPS, FHANDLE, UNIX, PACKET, IPV6,
  BLK_DEV_LOOP, EXT4, TMPFS, OVERLAY, SQUASHFS.
- **postmarketOS / Nura.** The project was renamed in Sept 2026, and gitlab/pkgs.postmarketos.org redirect to
  nura.eco. `linux-postmarketos-mediatek-mt6735` 7.0.10-r0 is still packaged, but **nothing depends on it** (the only
  user, samsung-grandpplte, is archived and booted through U-Boot). There is no Doogee X5 Pro device package. A pmOS
  port means writing `device-lenovo-tb7304x` plus a `linux-lenovo-tb7304x` package carrying our patches.
  pmOS's initramfs locates root through `pmos_root_uuid=`/labels on the cmdline, and kernel + pmOS initramfs is
  roughly at or over the 16 MiB recovery size. Worth doing only if you later want pmOS's UI/packages and upstreaming.
  It gives nothing extra for "shell + apk + ssh" (pmOS is Alpine underneath).
  I couldn't read gitlab.nura.eco (bot-blocked).
- **Debian (trixie arm64).** `debootstrap --foreign` works without qemu, but minbase + ssh + systemd is ~300–500 MB.
  That doesn't fit cache, and it is slower on 1 GB RAM. It only makes sense on a microSD.

## 3. Boot flow

### Stage 1 (`initramfs/init`, keep it)
Insert the following before the 300 s loop, after USB is up, so that a failed stage 2 still leaves the telnet/http
fallback running.

```sh
ROOTMODE=auto; for a in $(cat /proc/cmdline); do case "$a" in tb.r=*) ROOTMODE=${a#tb.r=};; esac; done
find_part() { for d in /sys/class/block/mmcblk0p*; do grep -qx "PARTNAME=$1" $d/uevent && { echo /dev/${d##*/}; return; }; done; }
try_rootfs() {
  [ "$ROOTMODE" = 0 ] && return 1
  C=$(find_part cache); [ -n "$C" ] || { log "no cache partition"; return 1; }
  mkdir -p /mnt/cache /newroot
  mount -t ext4 -o rw,noatime,nosuid,nodev "$C" /mnt/cache || return 1
  IMG=/mnt/cache/linux/rootfs.img; [ -f $IMG ] || { umount /mnt/cache; return 1; }
  n=$(cat /mnt/cache/linux/bootcount 2>/dev/null || echo 0)
  [ "$n" -ge 2 ] && { log "rootfs failed $n times, staying in initramfs"; umount /mnt/cache; return 1; }
  echo $((n+1)) > /mnt/cache/linux/bootcount; sync
  # optional: [ -x /bin/e2fsck ] && e2fsck -p $IMG
  mount -t ext4 -o loop,rw,noatime $IMG /newroot || { umount /mnt/cache; return 1; }
  [ -x /newroot/sbin/init ] || { umount /newroot /mnt/cache; return 1; }
  # stop stage-1 daemons that hold the old root and USB console
  killall telnetd httpd udhcpd 2>/dev/null; kill $(jobs -p) 2>/dev/null
  mkdir -p /newroot/mnt/cache; mount --move /mnt/cache /newroot/mnt/cache
  for m in dev proc sys run; do mkdir -p /newroot/$m; mount --move /$m /newroot/$m 2>/dev/null; done
  log "switch_root to $IMG"
  exec switch_root /newroot /sbin/init   # only returns on failure
}
```

- If `exec switch_root` fails, PID 1 is gone. Make the call robust: run `try_rootfs` only once everything has been
  checked (above). Alternatively wrap it as `switch_root ... || { reboot path }`, because busybox `switch_root`
  exits non-zero before exec only on bad arguments.
- Escape hatches, with no hands needed:
  - **Boot counter.** Stage 1 increments it. Stage 2 resets it to 0 after it has been up and reachable for 60 s.
    Two failed tries in a row mean stage 1 stays in the initramfs.
  - **Rescue image.** A second boot image with ` tb.r=0` (7 chars) on the cmdline. The current `CL` is 91 chars
    with `maxcpus=1`, and 98 with ` tb.r=0`. Now that SMP works, dropping `maxcpus=1` frees 10 more chars.
  - From Android, as root: `rm /cache/linux/rootfs.img` or `echo 9 > /cache/linux/bootcount`.
- Detecting cache by PARTNAME means **no `root=` on the cmdline**. The legacy-gadget `usb0` exists from kernel boot
  (g_cdc `0525:a4aa`), so stage 2 has networking without configfs.

### Kernel modules and firmware
- `CONFIG_MODULES` is off, so there is no `/lib/modules`. If modules are enabled later:
  `make modules_install INSTALL_MOD_PATH=…` into the rootfs `/lib/modules/7.0.10-tb7304x`. Keep `LOCALVERSION` fixed.
- No firmware is needed today: no WiFi, and musb/touch/keys need none. If needed later, it goes in the rootfs
  `/lib/firmware`. `FW_LOADER=y` loads directly, with no helper.

### Safety net in stage 2
- **Panic → reboot.** `CONFIG_PANIC_TIMEOUT=0` today, and the cmdline no longer has `panic=10`. If init dies after
  `switch_root`, the tablet hangs forever. Add `CONFIG_PANIC_TIMEOUT=10` (and maybe `CONFIG_PANIC_ON_OOPS=y`) to
  `config-tb7304x.fragment`. This costs no cmdline characters.
- **Autoreboot.** Install the script below as `/etc/local.d/tb-autoreboot.start`, made executable, and enable it
  with `rc-update add local default`. It keeps the 300 s / `/tmp/stay` semantics. Alpine's `/tmp` is not tmpfs by
  default, so add a tmpfs `/tmp` line to fstab, or use `/run/stay` as well.
  ```sh
  #!/bin/sh
  T=300; for a in $(cat /proc/cmdline); do case "$a" in tb.autoreboot=*) T=${a#tb.autoreboot=};; esac; done
  [ -f /etc/tb-autoreboot ] && T=$(cat /etc/tb-autoreboot)          # 0 = off, once stable
  ( sleep 60; echo 0 > /mnt/cache/linux/bootcount; sync          # reached userspace + 60 s: boot counts as good
    t=60; while [ "$T" -gt 0 ]; do sleep 5; t=$((t+5)); [ -e /tmp/stay ] || [ -e /run/stay ] && continue
      [ $t -ge "$T" ] && { echo 1 > /proc/sys/kernel/sysrq; sync; echo s > /proc/sysrq-trigger; echo u > /proc/sysrq-trigger; echo b > /proc/sysrq-trigger; }
    done ) </dev/null >/dev/null 2>&1 &
  ```
  Use sysrq `s,u,b` rather than `reboot -f`: the README notes `reboot -f` can hang. `mlsh.py wait` should then touch
  `/run/stay` over ssh instead of telnet.
- **Watchdog.** `WATCHDOG_HANDLE_BOOT_ENABLED=y` keeps the kernel petting it. Don't run a watchdog daemon unless it
  is wanted.

### Rootfs contents (Alpine)
- `/etc/inittab`:
  - `::sysinit:/sbin/openrc sysinit`, `::sysinit:/sbin/openrc boot`, `::wait:/sbin/openrc default`
  - `ttyGS0::respawn:/sbin/getty -L 115200 ttyGS0 vt100` (the ACM serial console)
  - `tty1::respawn:/sbin/getty 38400 tty1` (fbcon; it is unbound by stage 1, so drop the unbind if you want a
    console on screen)
  - `::shutdown:/sbin/openrc shutdown`
- `/etc/network/interfaces`:
  `auto lo` / `iface lo inet loopback` / `auto usb0` / `iface usb0 inet static` / `address 172.16.42.1` / `netmask 255.255.255.0`.
  The host already uses a static 172.16.42.2 NM profile, so no DHCP is needed. Optionally add `udhcpd` with the
  same config as stage 1.
- Services:
  - sysinit: `devfs dmesg mdev`
  - boot: `hostname bootmisc modules sysctl networking urandom`
  - default: `dropbear` (or `sshd`) and `local`
- `/root/.ssh/authorized_keys` with the host's key, `/etc/hostname` set to `tb7304x`, and the root password locked.
- `/etc/fstab`:
  - `/dev/loop0 / ext4 rw,noatime 0 0`
  - `tmpfs /tmp tmpfs nosuid,nodev 0 0`
- **RTC (implemented 2026-11-17):** the MT6328 RTC is `rtc0`; the kernel sets the clock at boot and `hwclock`
  applies it. Without an RTC the clock started in 1970, so:
  - TLS cert validity failed, so the image uses `http://` mirrors in `/etc/apk/repositories` (apk verifies package
    signatures anyway), or the time was set from the host at login: `ssh root@172.16.42.1 date -s @$(date +%s)`.
- **Package manager online without touching host network config.** Run a proxy on the host in Docker, bound to
  127.0.0.1:3128, then `ssh -R 3128:127.0.0.1:3128 root@172.16.42.1` and run
  `http_proxy=http://127.0.0.1:3128 apk add …` on the tablet. That needs no NAT or forwarding on the host.

## 4. Build and write

### Build on taos (x86_64, Docker; checked: no qemu binfmt registered, only llvm-19/python3.13)
**A. Cross, no qemu (no host change).** apk installs foreign-arch packages, but maintainer scripts can't run.
```sh
mkdir -p ~/tb7304-rootfs/out && cd ~/tb7304-rootfs
docker run --rm -v $PWD/out:/out alpine:3.24 sh -euxc '
  apk add --no-cache e2fsprogs
  R=/tmp/r; mkdir -p $R; V=3.24.4
  wget -q https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-minirootfs-$V-aarch64.tar.gz
  echo "4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de  alpine-minirootfs-$V-aarch64.tar.gz" | sha256sum -c
  tar xzf alpine-minirootfs-$V-aarch64.tar.gz -C $R
  # repositories + aarch64 signing keys come from the minirootfs itself
  apk --root $R --arch aarch64 --no-scripts --no-cache add alpine-base dropbear e2fsprogs nano htop
  # --no-scripts: do what the scripts would have done
  for s in devfs dmesg mdev; do ln -sf /etc/init.d/$s $R/etc/runlevels/sysinit/; done
  for s in hostname bootmisc sysctl networking urandom; do ln -sf /etc/init.d/$s $R/etc/runlevels/boot/; done
  for s in dropbear local; do ln -sf /etc/init.d/$s $R/etc/runlevels/default/; done
  # + copy inittab, interfaces, fstab, hostname, authorized_keys, local.d script (section 3)
  truncate -s 256M /out/rootfs.img
  mkfs.ext4 -q -L tbroot -O ^metadata_csum_seed -d $R /out/rootfs.img
  sha256sum /out/rootfs.img > /out/rootfs.img.sha256'
```
- Dropbear is suggested over openssh on path A. The openssh-server pre-install script creates the `sshd`
  privilege-separation user. Without scripts, add it by hand: append `sshd:x:22:22:…` lines to
  `passwd`/`group`/`shadow`.
- Busybox applet links already exist in the minirootfs.
- Later, on the device: `apk fix` with the proxy re-runs the scripts.

**B. qemu-user (most robust; needs your OK because it changes taos's kernel binfmt table until reboot).**
```sh
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker run --rm --platform linux/arm64 -v $PWD/out:/out alpine:3.24 sh -c 'apk add alpine-base openssh …'   # scripts run normally
```
Build the rootfs dir inside the arm64 container, then `mkfs.ext4 -d` as above.

Optional stage-1 additions:
- `e2fsck` for the image: Debian `e2fsck-static:arm64`, fetched with `apt-get download` in our Dockerfile the same
  way busybox-static is.
- The initramfs is currently included **twice**: in `CONFIG_INITRAMFS_SOURCE` and as the boot.img ramdisk. Drop one
  to free space under 16 MiB.

### Write to the tablet (in order of preference)
1. **Rooted Android (no fastboot, no raw partition writes).**
   ```sh
   adb shell su -c 'df -h /cache'                     # need > image size free
   adb push out/rootfs.img /data/local/tmp/rootfs.img
   adb shell su -c 'mkdir -p /cache/linux && cp /data/local/tmp/rootfs.img /cache/linux/rootfs.img.new && sync &&
     mv /cache/linux/rootfs.img.new /cache/linux/rootfs.img && echo 0 > /cache/linux/bootcount && sha256sum /cache/linux/rootfs.img &&
     rm /data/local/tmp/rootfs.img'
   ```
   Compare the hash with `rootfs.img.sha256`. Then reboot to fastboot, flash the new stage-1 image to `recovery`
   with `fb_send.py`, and run `oem reboot-recovery`, as today.
2. **From the mainline initramfs.** Mount cache rw, then on the tablet run
   `nc -l -p 5000 > /mnt/cache/linux/rootfs.img; sync`, and on the host `nc -q1 172.16.42.1 5000 < out/rootfs.img`.
   Check sha256 on both ends. This breaks the "eMMC read-only" convention deliberately and only inside cache.
3. **LK fastboot `flash:cache`.**
   - Only for a whole-filesystem image; not recommended.
   - Facts from `lk.bin`:
     - `max-download-size` = **`0x8000000` (128 MiB)**: the literal is loaded at 0x41e20f44, next to the
       `download:` registration.
     - Sparse images are supported (`cmd_flash_mmc_sparse_img`, "sparse image header invalid", and so on).
   - `fb_send.py` sends one download, so the sparse image must be ≤128 MiB. Make it with `img2simg`
     (`android-sdk-libsparse-utils`). Otherwise split it, which needs a multi-part sparse sender.
   - The fs must be exactly the partition size (`getvar:partition-size:cache`) and use features Android 7's old
     e2fsck accepts: `mkfs.ext4 -O ^metadata_csum,^64bit,^orphan_file,^metadata_csum_seed`.
   - It wipes Android's cache contents.

### Risks
- **Never write `userdata`, `system`, `metadata`, `nvram`/`nvdata`/`protect*` (IMEI/calibration), `para`
  (bootloader control block) or the GPT.** `metadata` holds the FDE crypt footer: losing it loses Android's data.
- Stock recovery's "wipe cache" or a factory reset deletes the rootfs. Keep the image on the host.
- A stage-2 hang with no panic: the safety net needs the `CONFIG_PANIC_TIMEOUT` fix plus the boot counter.
  The last resort is still holding Power for ~15 s, after which LK boots Android (recovery is one-shot via
  `oem reboot-recovery`).
- **Charger (implemented 2026-11-17):** the SM5414 driver keeps the battery safe on USB (4.10 V CV, temperature
  gate). With the old no-driver behavior, long stage-2 sessions drained the battery; watch it and set autoreboot
  back to Android as default.
- Unclean shutdowns (sysrq `b`) on a loop-mounted ext4: the journal covers it. Do `s,u` first. Android's boot-time
  `check` only fscks the outer cache fs.
- Path A rootfs differs from a "real" install because no post-install scripts ran. Run `apk fix` once online.
- Unverified: cache size and free space, `ro.crypto.state` on this unit, Alpine 3.24 `apk --root --arch` with
  `--no-scripts` (apk v3), and whether busybox-static's `switch_root`/`nc -l` match the flags above (Debian's
  busybox-static has both).

## Sources
- Repo: `mainline/README.md`, `TEST-PLAN.md`, `initramfs/init`, `scripts/build-in-docker.sh`, `patches/config-tb7304x.fragment`,
  `out/build5/kernel.config`, `scripts/analysis/fb_send.py`, `backup/partitions/{boot,recovery,lk}.bin` (fstab, init.rc, LK disassembly).
- Alpine latest-stable aarch64: https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64/latest-releases.yaml
- pmOS → Nura rename: https://linuxiac.com/postmarketos-is-now-nura-after-major-project-rebrand/ ,
  https://itsfoss.com/news/postmarketos-nura-rebranding/
- Kernel package: https://pkgs.nura.eco/package/main/postmarketos/aarch64/linux-postmarketos-mediatek-mt6735 (7.0.10-r0, required by: none)

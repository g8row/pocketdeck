# Stage 4 · Linux on the eMMC

Stage 4 of 5 · **you are here:** U-Boot in `boot`, Android in `recovery` · **you need:** stage 3, Docker or a build
host · **you end with:** Alpine booting from `tbkern_a` + `tbroot_a` by default and reaching `healthy`
Previous: [03](03-uboot.md) · Next: [05 PocketDeck](05-pocketdeck.md) · If it fails: [recovery](recovery.md)

## 1. Build

```sh
./pd build all        # kernel + boot images, then the Alpine rootfs image (device/rootfs/out/rootfs.img)
```

The rootfs bakes in your ssh public key (`PD_SSH_PUBKEY`, default `~/.ssh/id_ed25519.pub`), Mesa if
`device/gpu/out/mesa-opt.tar.gz` exists (`pd build mesa`), and the tablet tools from `device/out`.

## 2. First boot: the `cache` slot

The first Linux has to run from somewhere other than the slots it will write. U-Boot's `cache` slot boots
`/cache/linux/boot-mainline-uboot.img` with the root in the loop file `/cache/linux/rootfs.img`, and stage 1
unpacks a `rootfs.img.gz` dropped next to it. From Android (root):

```sh
gzip -1 -k device/rootfs/out/rootfs.img
adb shell su -c 'mkdir -p /cache/linux'
adb push device/out/boot-mainline-uboot.img device/rootfs/out/rootfs.img.gz /data/local/tmp/
adb shell su -c 'mv /data/local/tmp/boot-mainline-uboot.img /data/local/tmp/rootfs.img.gz /cache/linux/'
./pd slot cache                                  # from Android: pushes device/out/tbstate, sets the record
tools/linux-test.sh to-linux
```

After ~30 s:
`./pd state` over ssh shows `cmdline slot: cache`.

## 3. Format and install slot A

```sh
./pd ssh 'for p in tbroot_a tbroot_b tbdata; do d=/dev/$(grep -l "PARTNAME=$p\$" /sys/class/block/mmcblk0p*/uevent | cut -d/ -f5); mkfs.ext4 -F -L $p $d; done'
tools/wifi-deploy.sh                            # WiFi firmware + this tablet's NVRAM, from backup/ (optional, now or later)
./pd install --slot a kernel rootfs             # writes, verifies, records /data/pocketdeck/slot-a.*
./pd ssh 'd=/dev/$(grep -l "PARTNAME=tbrescue$" /sys/class/block/mmcblk0p*/uevent | cut -d/ -f5); cat > $d; sync' < device/out/boot-mainline-uboot.img
./pd slot a && ./pd reboot linux
```

`tbrescue` gets a known-good kernel once and is never touched by updates (U-Boot boots it when slot attempts are
exhausted; its stage 1 stays in the initramfs).

## 4. Check

Wait about a minute, then:

```sh
./pd state       # slot a, stage=healthy, last_good_slot=a, attempts=0
```

`healthy` is written 60 s after stage 2 starts. Don't reboot before it: three Linux boots in a row without
`healthy` send the tablet to `tbrescue`, then to Android ([recovery](recovery.md)). WiFi: `pd ssh 'wifi-up save
<ssid> <password>'` stores a network in `/data/wifi` (survives root reinstalls).

## Later updates

Always into the slot that is not running, so the running one stays as the fallback:

```sh
./pd build all
./pd install kernel rootfs        # default target: the inactive slot
./pd slot b && ./pd reboot linux  # then pd state: healthy, last_good_slot=b
./pd slot a && ./pd reboot linux  # if b misbehaves
```

Kernel-only experiments without writing anything: `./pd ramboot` (U-Boot `fastboot boot`; the next normal boot is
the installed system again).

Next: [05 PocketDeck](05-pocketdeck.md)

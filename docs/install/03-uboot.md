# Stage 3 · U-Boot in `boot`, Android in `recovery`

Stage 3 of 5 · **you are here:** rooted Android, new GPT · **you need:** stage 2, Docker or a build host,
`magisk-boot.img` from stage 1 · **you end with:** power-on → LK → U-Boot; Android one step away in `recovery`
Previous: [02](02-repartition.md) · Next: [04 Linux](04-linux.md) · If it fails: [recovery](recovery.md#vol-menu-at-power-on)

How the chain works and why: [boot-chain.md](../architecture/boot-chain.md).

## 1. Build

```sh
./pd build kernel          # initramfs, kernel, U-Boot -> device/out/{u-boot-tb7304x.img, boot-mainline-uboot.img, tbstate}
```

`build-uboot.sh` pads U-Boot's image to LK's contract and rejects it (`*.REJECTED`) unless
`device/analysis/lk_image_check.py` passes. Never write anything into `boot` that fails that check.

## 2. Android into `recovery` first

So Android stays reachable whatever happens to `boot`. LK fastboot (`tools/linux-test.sh to-fastboot` from Android),
then:

```sh
tools/fbusb tools/magisk/magisk-boot.img flash:recovery
tools/fbusb - "oem reboot-recovery"            # Android from recovery: check it boots and is rooted
```

## 3. U-Boot into `boot`

```sh
tools/linux-test.sh to-fastboot                # from Android, safely (Magisk counter)
./pd flash uboot                               # lk_image_check, then fbusb flash:boot; asks for confirmation
```

On the next power-on LK starts U-Boot from `boot`. The `tbstate` partition is blank, so U-Boot creates the boot
record (default Linux). With no Linux installed yet, U-Boot finds no image in `tbkern_a` and falls back
(boot-chain.md describes the order); Android is always reachable via:

- `adb reboot recovery`, LK's Vol+ menu → Recovery, or `pd reboot android-direct` from Linux;
- the boot record: `pd boot default android` (Android as default until stage 4 is done).

Charger-plugged-while-off and RTC-alarm boots go to Android automatically.

Done when: a plain reboot shows U-Boot's handover (Linux or its fallback), and `adb reboot recovery` brings Android
up rooted.

Next: [04 Linux](04-linux.md)

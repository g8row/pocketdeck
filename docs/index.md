# Docs

**Start here:** [install/](install/00-prerequisites.md) (stock tablet → PocketDeck), then [dev/workflow.md](dev/workflow.md).

## Install (in order)
- [00-prerequisites.md](install/00-prerequisites.md): host tools, clone, `pd doctor`, USB network
- [01-backup-unlock-root.md](install/01-backup-unlock-root.md): BROM dump, seccfg unlock, Magisk, the required module
- [02-repartition.md](install/02-repartition.md): the `tb*` partitions carved from `userdata`
- [03-uboot.md](install/03-uboot.md): U-Boot into `boot`, Android into `recovery`
- [04-linux.md](install/04-linux.md): first Linux from `/cache`, then slot A; later updates via the inactive slot
- [05-pocketdeck.md](install/05-pocketdeck.md): the UI service, deckd, Claude Code hooks
- [recovery.md](install/recovery.md): when something goes wrong, least to most invasive

## Architecture
- [boot-chain.md](architecture/boot-chain.md): LK → U-Boot → Linux/Android, eMMC layout, `tbstate`, slots, boot menu
- [deckd/README.md](../deckd/README.md): the host daemon, its providers, protocol, settings, Deck Studio

## Hardware
- [status.md](hardware/status.md): **the live status**: what works, measurements, known issues, next steps
- [research-display.md](hardware/research-display.md): D2 address map, NT51021B panel, DRM bring-up
- [research-power.md](hardware/research-power.md): SM5414 charger, battery ADC/fuel gauge, RTC, thermal, I2C, accelerometer
- [research-wifi.md](hardware/research-wifi.md): MT6625L WiFi/BT via CONSYS
- [research-rootfs.md](hardware/research-rootfs.md): the Alpine root on the eMMC
- [research-poweroff.md](hardware/research-poweroff.md): power off, PMIC long-press reset
- [research-lk-bootflow.md](hardware/research-lk-bootflow.md): stock LK disassembled, the image contract
- [research-stock-firmware.md](hardware/research-stock-firmware.md): stock boot image, stock DTB, LK facts

## Development
- [workflow.md](dev/workflow.md): day-to-day `pd` commands, safety rules, where things are
- [build.md](dev/build.md): what each build makes, inputs, enforced checks, build identity
- [lessons.md](dev/lessons.md): facts that cost time to learn
- [conventions.md](dev/conventions.md): branches, commits, docs, privacy
- [ui-redesign.md](dev/ui-redesign.md): the UI redesign plan, integration steps and the plumbing briefs

## Elsewhere
- [device/u-boot/README.md](../device/u-boot/README.md): U-Boot board files and patches
- [device/wcn/README.md](../device/wcn/README.md): origin of the WiFi/BT driver
- [archive/android/](../archive/android/README.md): the Android era (the debloat module is still required)
- [history/](history/README.md): retired docs, readable at tag `android-era-final`
- [RESTRUCTURE-PLAN.md](../RESTRUCTURE-PLAN.md): the PocketDeck restructure and its progress

# History

The project started as an Android desk display (rooted stock Android, a debloat module, a PocketJS APK, a kiosk
mode), then moved to mainline Linux over a few nights in November 2026. The documents from that period were
retired in the PocketDeck restructure; they are kept in git at tag **`android-era-final`**:

```sh
git show android-era-final:<path>          # e.g. git show android-era-final:plan-boot-recovery.md
```

| Path at the tag | What it was | Superseded by |
|---|---|---|
| `LOG.md` | overnight build log of the Android era: perf work, panes, kiosk, GPU test | [lessons](../dev/lessons.md) (UI/perf) |
| `PLAN-overnight.md` | the first plan | — |
| `plan-boot-recovery.md` | boot/recovery design study: options A–G, phases, RTC/BCB analysis | [boot-chain](../architecture/boot-chain.md) |
| `docs/mainline/handoff-uboot-2026-11-17.md` | U-Boot chainload session handoff | [research-lk-bootflow](../hardware/research-lk-bootflow.md), lessons |
| `docs/mainline/plan-dualboot.md` | the dual-boot plan, migration steps, T0–T9 test log | [boot-chain](../architecture/boot-chain.md), [install/02](../install/02-repartition.md) |
| `mainline/README.md` | 2026-11-16 bring-up record | [build](../dev/build.md), [research-stock-firmware](../hardware/research-stock-firmware.md) |
| `mainline/TEST-PLAN.md` | bring-up test plan (flash-`recovery` route, now forbidden) | [recovery](../install/recovery.md) |
| `docs/ONBOARDING.md` | Android-first onboarding | [install/](../install/), [archive/android](../../archive/android/README.md) |
| `docs/mainline/STATUS.md` (long form) | status with per-day tablet states | [status](../hardware/status.md) |

Paths that moved rather than retired (`mainline/` → `device/`, `deskd/` → `deckd/`, …) are listed in
[RESTRUCTURE-PLAN.md](../../RESTRUCTURE-PLAN.md); `git log --follow` works across the moves.

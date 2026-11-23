# Stock LK on the TB-7304X: boot flow, image contract, and the dual-boot decision

**Date:** 2026-11-17. **Input:** `backup/partitions/lk.bin` (MTK LK, "Build time: Aug 28 2018 19:30:47", Thumb-2,
linked at `0x41E00000`, 0x200-byte MTK header). **Method:** full capstone disassembly with string and literal
annotation, function by function along the boot path; an offline model of LK's image checks
([`lk_image_check.py`](../../mainline/scripts/analysis/lk_image_check.py)); the session log of the 2026-11-16 tests.
**Read with:** [plan-dualboot.md](plan-dualboot.md) (the decided design and live test status),
[handoff-uboot-2026-11-17.md](handoff-uboot-2026-11-17.md), [plan-boot-recovery.md](../../plan-boot-recovery.md).

Every claim below carries the LK address it was read from. "Verified" means read in the disassembly.
"Inferred" means it follows from the code plus the device logs, but was not observed directly.

---

## 1. The answer

**The U-Boot failures were not path-dependent. They were RAM-dependent, caused by our image.**

1. LK does **not** use the DTB inside the RAM copy of the kernel. Early in `platform_init`, before the boot mode is
   chosen, `bldr_load_dtb` (`0x41e1f20c`) reads the **last 512 KiB of the kernel area straight from the partition**,
   finds the last `d00dfeed`, and copies that FDT to the header's `tags_addr` (`0x4e000000`). That copy is what LK
   patches and hands over in `x0`. *(verified)*
2. The read offset is `roundup(page + kernel_size, page) − 0x80000`, computed in 32 bits (`0x41e1f318`). Our U-Boot
   kernel area is `0x5883b` bytes (gzip U-Boot + stock DTB), so the offset underflows to `0xfffd9800`.
   `partition_read` rejects it ("Incorrect range", `0x41e1c5dc`), `bldr_load_dtb` returns −1, and `platform_init` just
   prints `bldr_load_dtb fail` and carries on (`0x41e02220`). *(verified)*
3. At the jump, `boot_linux_fdt` (`0x41e1f484`) uses **whatever is at `0x4e000000`**. If the previous boot left a valid
   FDT there, U-Boot starts. If not, LK prints "Can't find device tree" and spins in `b .` (`0x41e1f59a`) *after*
   decompressing U-Boot but *before* jumping. No white band appears, and LK's 10 s watchdog
   (§3.8) resets the tablet into the same loop. *(verified)*
4. **Reproduced on the device (2026-11-17, §8):**
   - When the previous kernel was started **by LK**, its FDT sits at `0x4e000000` and that kernel keeps it
     protected. It survives any amount of I/O, so U-Boot starts afterwards (T0a).
   - When the previous Android was started **by U-Boot**, which moves the FDT to `0x4f000000`, `0x4e000000` is
     ordinary free memory. Heavy I/O overwrites it, and the next U-Boot boot hangs in LK (T0, the P2 sequence).
   - The padded image boots in that same state (T1).
   - Second, independent proof: LK adds `/firmware/android` with `fdt_add_subnode`, which fails on a leftover tree
     that already has the node. `mode` then keeps the previous boot's value. That is why `ro.boot.mode` read `normal`
     in P1 and `recovery` once the DTB was loaded fresh (§3.7).
5. Within LK, **the RTC flag, the BCB, and the volume-menu routes into recovery behave the same** for an image in
   `recovery`, and **the normal route behaves the same** for an image in `boot`. They pick the same DTB source
   partition, the same loader, the same verified-boot step and the same jump code (§3). *(verified)* The earlier
   matrix ("RTC works, normal and BCB loop") was an artifact of test order.

**Fix:** make the kernel area of any image LK boots **≥ 0x7f001 bytes** (use ≥ 512 KiB) with the FDT appended
at its end. For U-Boot: `gzip(u-boot.bin) ‖ zero padding ‖ stock.dtb`. LK's gunzip stops at the end of the deflate
stream (`0x41e20776`, `Z_STREAM_END`), so the padding is ignored. A padded image built from the current
`u-boot-tb7304x.img` passes the checker (§4).

**Boot-flow recommendation** (§7): U-Boot (padded) in `boot` as the default, autobooting Linux. Android in
`recovery`, reachable **without U-Boot** through LK's own recovery path (volume menu, or the one-shot RTC bit). No
BCB, ever. Validate in the order of §8, Android-safe tests first.

---

## 2. Confidence and limits

| Claim | Basis | Confidence |
|---|---|---|
| DTB source = partition tail, read in `platform_init` | disassembly `0x41e1f20c`, caller `0x41e01f94` | certain |
| U-Boot image makes that read fail | arithmetic on its header + `partition_read` bounds check | certain |
| LK then boots with the stale FDT at `tags_addr` | `boot_linux_fdt` 64-bit path uses `fp = tags` (`0x41e1f522`), no copy | certain |
| RTC / BCB / menu recovery are equivalent inside LK | all set `g_boot_mode = 2`; every later branch tests only the mode value | high (all 25 readers of `g_boot_mode` listed, §3.4) |
| Leftover FDT is lost when the previous Android was U-Boot-launched and did heavy I/O | T0 reproduced it; T1 fixed it | verified on device |
| An LK-launched 3.18 kernel keeps its FDT at `0x4e000000` intact | T0a: U-Boot started after 1.5 GB of I/O | verified on device |
| Why the BCB run and P2b failed | their previous boots had an LK-placed FDT, so this mechanism predicts success | **unexplained** (neither route is used any more) |

Not covered: the preloader (only its handshake fields), ATF internals beyond the SMC entry, and the 32-bit kernel path.

---

## 3. LK boot flow, step by step

### 3.1 `platform_init` (`0x41e01f0c`) order

| # | Step | Address | Notes |
|---|---|---|---|
| 1 | eMMC init | `0x41e01f7c` | |
| 2 | **`bldr_load_dtb("boot")`** | `0x41e01f94` | Source partition chosen inside (§3.2). Failure only prints `bldr_load_dtb fail`. |
| 3 | LEDs, ENV (`para`-based lk_env), display init, `FB base` | `0x41e01fa6`–`0x41e02090` | FB base is at `0x7f7b0000` in practice |
| 4 | security init (seccfg, lock state) | `0x41e020a0` | |
| 5 | **`boot_mode_select`** | `0x41e020ea` → `0x41e02c60` | §3.3 |
| 6 | if mode == RECOVERY: **`bldr_load_dtb("recovery")`** again | `0x41e022f8` | covers the volume-menu route |
| 7 | load `logo` partition, show boot logo (unless mode 7–9/99) | `0x41e02128`, `0x41e02230` | |
| 8 | battery init, **`rtc_boot_check`** | `0x41e0216e` → `0x41e0ca2c` | **clears the RTC recovery bit** (§3.5) |
| 9 | KPOC handling, backlight, sw_env | `0x41e0218a`… | |

Then the `mt_boot` app (`0x41e205f0`) builds the serial number and calls `boot_linux_from_storage` (`0x41e20308`),
unless the mode is FASTBOOT (99), in which case it starts fastboot (`0x41e2069a`).

### 3.2 `bldr_load_dtb(name)` — where the handed-over DTB comes from (`0x41e1f20c`)

```
part = RTC_PDN1[5:4] == 01 ? "recovery"          // 0x41e1f224 → 0x41e0ce18 (does NOT clear the bit)
     : BCB "boot-recovery" in para ? "recovery"   // 0x41e1f396 → 0x41e05c10 (also sets g_boot_mode = 2)
     : name;
hdr = partition_read(part, 0, 0xa60)
require "ANDROID!"; parse bootopt → sets is_64bit                       // 0x41e1f25c
if is_64bit:
    off = (kernel_size + 2*page - 0x80000 - 1) & ~(page-1)   (u32!)    // 0x41e1f318
    buf = partition_read(part, off, 0x80000)                            // fails if off+0x80000 > part size
    scan buf backwards from +0x7fffc for d00dfeed (last occurrence)     // 0x41e1f350
    memcpy(hdr.tags_addr, fdt, fdt_totalsize)                           // 0x41e1f2d2
    fdt_open_into(tags, tags, 2 MiB)                                    // 0x41e1f2e8
```

Consequences:
- The handed-over DT is **the FDT at the end of the kernel area of the partition LK booted from**, never `second`.
- A kernel area **< 0x7f001 bytes** cannot work (underflow). This was the U-Boot image.
- The kernel tail must not contain a later `d00dfeed` than the intended FDT.

### 3.3 `boot_mode_select` (`0x41e02c60`) — priority order

First match wins:

1. **kedump** crash-dump hook (`0x41e21760`). AEE only, no mode change.
2. **Preloader handshake** (`0x41e055b8`): if the preloader passed META/FACTORY/ATE/ADVMETA/FASTBOOT (`'LPLP'` magic at
   `+0x0`, mode byte at `+0x4`), use it.
3. **RTC fastboot bit** `RTC_PDN1[13]` (`0x41e0cdf4`) → FASTBOOT (99) and clear the bit (`0x41e02d76` → `0x41e0cdb0(0)`).
4. **RTC recovery** `RTC_PDN1[5:4] == 01` (`0x41e0ce18`) → RECOVERY (2). Not cleared here (§3.5).
5. "PMIC just reset" check (`0x41e0508c`) and factory-forbid (`'LLLL'` at preloader args `+0x124`).
6. **BCB**: `para` offset 0, `command == "boot-recovery"` (`0x41e05c10` → `0x41e0555c`) → RECOVERY. **LK never
   clears it.**
7. **Keys**, polled for ~50 ms (`0x41e02cf8`–`0x41e02d20`): key 0 (Vol+, the boot-menu key) opens the **boot menu**
   (`0x41e05984`). Key 1 is the factory key → mode `0xb`. *(Vol+ verified on the device; Vol− for key 1 inferred)*
8. **KPOC** detection (`0x41e1bccc`): power-on caused by plugging in the charger → mode 8.
9. Otherwise NORMAL: "< Kernel Enter Normal Boot >".

Because the BCB check (6) runs **before** the key poll (7), a BCB hides the volume menu on every boot. That is what
locked us out on 2026-11-17. The RTC bits (3, 4) also run before the keys, but they are one-shot.

### 3.4 Mode → partition (`boot_linux_from_storage`, jump table at `0x41e2032a`)

| `g_boot_mode` (`0x41e58818`) | Loads |
|---|---|
| 2 RECOVERY | `recovery` (`0x41e20494`) |
| 4 FACTORY, 6 ATE_FACTORY | `boot`, logged as "factory.img" (`0x41e2042a`) |
| 0 NORMAL, 1 META, 3, 5, 7 ALARM, 8 KPOC, 9 LOW_POWER_KPOC, 11 | `boot` (`0x41e204fe`) |
| 10 | nothing loaded |
| 99 FASTBOOT | no boot; fastboot (`0x41e2067e`) |

All 25 places that read `g_boot_mode` were checked. Apart from this table, the mode only affects the logo choice,
KPOC power-off, META/factory handling, and the `androidboot.mode`/`atag,boot` values handed to the kernel.
**Nothing distinguishes RECOVERY reached by RTC, by BCB, or by the menu.**

### 3.5 RTC bits (`RTC_PDN1`, PMIC reg `0x402c`)

| Bit | Meaning | Read | Cleared |
|---|---|---|---|
| `[5:4] == 01` | recovery, one-shot | `0x41e0ce18` (in `bldr_load_dtb` and `boot_mode_select`) | `rtc_boot_check` `0x41e0ca8c` (`& ~0x10`), step 8 of §3.1, **before** any image is loaded |
| `[13]` | fastboot, one-shot | `0x41e0cdf4` | `boot_mode_select` |
| `[6]` | also cleared by `rtc_boot_check` (`0x41e0caa8`) | | |

Set by: LK `oem reboot-recovery` (`0x41e21330`, then reset), the stock kernel's `reboot recovery`, and our
`tb-reboot`/`mtk-rtc-boot-mode`. Because LK clears the recovery bit **before** loading, a recovery image that hangs
costs **one** failed boot. The next reset is a normal boot.

### 3.6 Loading the image (`0x41e033b8` boot, `0x41e03694` recovery; bodies `0x41e03924` / `0x41e03ad8`)

1. Read the 0x260-byte header; require `ANDROID!`; log sizes. The `boot` variant re-parses bootopt. The
   `recovery` variant relies on the `is_64bit` value set by `bldr_load_dtb`.
2. **Verified boot** (`0x41e030d4`, same function for both): device unlocked → state *orange* → "Orange State… boot in
   5 seconds" screen with a 5 s `mdelay` (`0x41e02f9c`), then `androidboot.verifiedbootstate=orange` is appended.
   This costs 5 s on every boot and cannot be avoided without relocking.
3. Read the whole body (kernel + ramdisk pages) to the **scratch address `0x45000000`** (`0x41e04468`). The ramdisk
   is then copied to `ramdisk_addr`.
4. The header cmdline is copied with `snprintf(…, 100, …)` (`0x41e20396`): **at most 99 characters**.

Header errors go to `0x41e1f054`, which disables the WDT, waits 8 s and resets. The volume menu stays reachable.

### 3.7 `boot_linux_fdt` (`0x41e1f484`), 64-bit path

1. `kernel_addr & 0x7ffff` must be 0, otherwise "64 bit kernel can't boot at …" and a hang (`0x41e1f4e2`).
2. Scan the RAM blob (`0x45000000 + kernel_size`) backwards for `d00dfeed`. This is used only to size the zImage
   (`zimage_size = kernel_size − align4(distance to end)`). No appended FDT → `fp = 0` → hang.
3. Check the gzip header (`0x41e207cc`, method 8, no reserved flags), then raw-inflate to `kernel_addr`, at most
   28 MiB (`0x1c00000`). It succeeds on `Z_STREAM_END`, so trailing bytes are ignored.
4. **Require an FDT at `tags_addr`**, the one `bldr_load_dtb` copied (or stale RAM) (`0x41e1f568`). Otherwise
   "Can't find device tree. Please check your kernel image" and `b .` (`0x41e1f59a`).
5. Require `tags + dtb_size < FB base`. Patch the tree: `/memory`, `/chosen` initrd and bootargs, `atag,boot`
   (bootmode, boot reason), `atag,mem`, `atag,videolfb`, `atag,devinfo`, `atag,mdinfo`, `ccci,modem_info*`, `atag,ptp`,
   `atag,masp`, `tee_reserved_mem`, `non_secure_sram`, `boot_reason=`, `androidboot.serialno=`,
   `androidboot.bootreason=` (`0x41e1f6bc`–`0x41e1fce6`). Also `/firmware/android/{compatible,hardware,serialno,mode}`
   (`0x41e04780`): `mode` is `normal`, `recovery`, `charger` (KPOC), `factory` or `meta`. Android's init turns it
   into `ro.boot.mode`. LK creates the node with `fdt_add_subnode`; if it already exists (a leftover tree), LK
   prints "can't add firmware node" and leaves the old values. Anything that starts Android in normal mode from a
   recovery-mode LK boot must patch both `atag,boot` and this `mode` (U-Boot `tbandroid` does since 2026-11-17).
6. KPOC: if the charger was unplugged in the meantime, power off (`0x41e1fd6a`).
7. `jump_to_K64` (`0x41e1f444`) → ARM-mode `smc #0` (`0x41e1d424`) into ATF with r1 = entry, r2 = FDT. ATF enters
   the AArch64 kernel at EL1/EL2 with `x0` = `tags_addr`.

### 3.8 Watchdog

`mtk_wdt_init` (`0x41e0c7cc`) programs a **10 s** timeout (`0x41e0c826`: 10 → `WDT_LENGTH`) and mode `0x5d`
(enable | ext | irq | auto-restart | dual), and leaves it **running across the jump**. LK disables it only around the
boot menu and before its own error resets (`0x41e0c788`). Whatever LK starts must kick or reprogram the WDT
within ~10 s. Any LK hang becomes a reset with boot reason `wdt_by_pass_pwk` (auto-restart = "bypass power key").

### 3.9 Fastboot

`fastboot_init(0x45000000, 0x8000000)` (`0x41e20694`): the download buffer ends at `0x4d000000` and does not touch
`tags`. Commands: `flash:`, `getvar`, `reboot`, `reboot-bootloader`, `oem reboot-recovery`, `oem p2u`,
`oem append-cmdline`, `oem off-mode-charge`. There is **no `boot`**.

### 3.10 Memory map LK uses

| Address | Use |
|---|---|
| `0x40080000` | kernel decompress target (header `kernel_addr`; must be 512 KiB aligned) |
| `0x41e00000` | LK itself |
| `0x43000000`, `0x43f00000`… | ATF, ram_console, pstore (stock DT reserved-memory) |
| `0x44000000` | ramdisk (header `ramdisk_addr`) |
| `0x45000000` | image body load / fastboot download buffer (128 MiB) |
| `0x4e000000` | **FDT** (header `tags_addr`), expanded to 2 MiB |
| `0x7f7b0000` | framebuffer |

---

## 4. The image contract (64-bit images LK boots from `boot` or `recovery`)

| # | Rule | Why (address) |
|---|---|---|
| 1 | `ANDROID!` v0 header, page 2048 | `0x41e034c4` |
| 2 | Header cmdline contains `bootopt=64S3,32N2,64N2` (third field `64`) | `0x41e1f18c` |
| 3 | `kernel_addr` 512 KiB aligned (`0x40080000`) | `0x41e1f4e2` |
| 4 | Kernel = **gzip**, followed by the FDT LK should hand over, appended at the end | `0x41e207cc`, `0x41e1f4ea` |
| 5 | **Kernel area ≥ 0x7f001 bytes** (use ≥ 512 KiB; zero-pad between gzip and FDT if needed) | `0x41e1f318` |
| 6 | No `d00dfeed` after the intended FDT | backwards scans |
| 7 | Decompressed ≤ 28 MiB and must not reach LK at `0x41e00000` | `0x41e1f5c8` |
| 8 | Header cmdline ≤ 99 chars (LK truncates) | `0x41e20396` |
| 9 | `tags_addr` = `0x4e000000`, FDT ≤ 2 MiB | `0x41e1f2e8` |
| 10 | The started code kicks or takes over the WDT within ~10 s | §3.8 |

Check any image before flashing it:

```sh
mainline/scripts/analysis/lk_image_check.py <image-or-partition-dump>...
```

Current results:

| Image | Result |
|---|---|
| `backup/partitions/boot.bin` (stock), `boot-magisk.img` | OK |
| `mainline/out/boot-mainline.img` (kernel #24 for LK) | OK |
| U-Boot image as built until 2026-11-17 (`bc5937ad…`) | **FAIL**: rule 5 |
| U-Boot image built by the current `build-uboot.sh` (padded, kernel area 0x80002; deployed in `recovery`, `672f2f9a…`) | OK, FDT found at offset 0x70764 |
| `mainline/out/boot-mainline-uboot.img` | FAIL (no bootopt, DTB in `second`). Expected: it is for U-Boot only. |

`mainline/u-boot/build-uboot.sh` now pads the gzip stream with zeros up to `0x80000 − len(stock.dtb)` (rounded
to 4), then appends the DTB. It runs the checker as a build gate: a failing image is renamed `*.REJECTED`.

---

## 5. The 2026-11-16 results, re-explained

Times are UTC from the session log (EET = UTC+2). The deciding question is who started the previous kernel
(§1.4). If it was LK, the FDT at `0x4e000000` is protected and U-Boot starts. If it was U-Boot (FDT moved to
`0x4f000000`), heavy I/O can overwrite it.

| Run | Previous boot | Route | Observed | Explained? |
|---|---|---|---|---|
| runs 1–6, 7, Linux runs (21:02–22:00) | Android started by LK | RTC → `recovery` | ✅ | yes |
| P1 (22:11) | Android started by LK | RTC | ✅ (`ro.boot.mode=normal` was left over, §3.7) | yes |
| p1a (22:13) | Android started by U-Boot, 2 min, light I/O | RTC | ✅ | yes (not yet overwritten) |
| **P2** (22:16) | Android started **by U-Boot**, then 2×16 MiB dumps + 12 MiB push + `dd`/`cmp` | normal → `boot` | ❌ loop | **yes**, reproduced as T0 |
| **P2b** (22:34) | Android started by LK from `recovery`, then LK fastboot `flash` and LK's own `reboot` | normal → `boot` | ❌ loop | **no** (perhaps LK's reset doesn't keep DRAM; unverified) |
| **BCB** (23:05) | Android started by LK (recovery mode), then 32 MiB pushes + `dd` | BCB → `recovery` | ❌ loop | **no** |
| loops after a failure | no OS ran in between | — | ❌ forever | yes: nothing restores the FDT |

All of these runs used the unpadded image. With the padded image, the DTB is read from the partition on every
route, so leftover RAM no longer matters. Even the unexplained cases can't recur with it.

Other observations explained by the same mechanism:
- No white band in the failing runs: LK decompresses U-Boot, then spins before the jump (§3.7 step 4).
- About 32 s per loop: preloader + LK + 5 s orange screen + load + 10–20 s WDT (dual mode).
  `last_kmsg` `hw_status: 2` and `wdt_by_pass_pwk` agree.
- "LK honors BCB and the menu disappears": verified (§3.3).
- The handoff's double-buffered-framebuffer hypothesis is not needed. U-Boot never ran in those boots.

**Corrections to earlier documents:**
- Handoff §4.1/§5 "LK's normal and BCB paths do not lead to a visible U-Boot": they do, for a contract-compliant image.
- Handoff §7 "If LK's normal path refuses everything but stock images…": it accepts any image meeting §4. Mainline
  kernel #24 already met it (it booted from `recovery` through LK).
- Plan §1.2 "LK reads and clears them [RTC bits] when it acts on them": correct, and the recovery bit is cleared
  **before** the image is loaded, so a bad recovery image is self-healing.
- Plan §3.3 / decision 6 (BCB as a transport): rejected permanently. LK never clears the BCB, and the BCB disables
  the volume menu.

---

## 6. What this means for each path into the tablet

| Route | Who triggers it | One-shot? | Volume menu still works? | Loads |
|---|---|---|---|---|
| Cold power-on, `reboot`, KPOC, alarm | default | — | yes | `boot` |
| RTC recovery bit | `adb reboot recovery`, `tb-reboot recovery`, LK `oem reboot-recovery` | yes (cleared before load) | not on that boot | `recovery` |
| RTC fastboot bit | `adb reboot bootloader`, `tb-reboot bootloader` | yes | not on that boot | LK fastboot |
| Volume menu (hold Vol+ at power-on) | human | — | — | Recovery → `recovery`, Fastboot, Normal → `boot` |
| BCB `boot-recovery` | anything writing `para` | **no, persistent** | **no** | `recovery` (forever) |
| Charger plugged while off | hardware | — | — | `boot` with mode 8 (KPOC); LK powers off if unplugged |

---

## 7. The boot flow decision

> Decided 2026-11-17. The full design (layout, GUI, migration, validation) is
> [plan-dualboot.md](plan-dualboot.md). This section keeps the reasoning.

Requirements: Linux boots by default with no input; Android stays one step away; no single bad image or bad U-Boot
build can leave the tablet without a no-tools way back to Android.

Only `boot` is loaded on the default routes (§3.4), so autobooting Linux means `boot` holds either Linux or a chooser.

### Recommended: U-Boot in `boot`, Android in `recovery` (option B, revised)

```
BROM → preloader → LK (stock, untouched)
  ├─ default (cold, reboot, KPOC, alarm) → boot = U-Boot (padded, §4)
  │     ├─ KPOC / alarm / LK bootmode ≠ normal → Android (tbandroid from `recovery`, bootmode → normal)
  │     ├─ intent = android (ledger / cache file) → Android (tbandroid)
  │     ├─ intent = fastboot or a key held → U-Boot fastboot (`fastboot boot`, RAM only)
  │     └─ default → Linux (kernel + DTB + initramfs from cache/microSD), boot counter, fallback to Android
  ├─ RTC recovery bit, or Vol+ menu → Recovery → recovery = Android+Magisk, U-Boot NOT involved
  └─ RTC fastboot bit, or Vol+ menu → Fastboot → LK fastboot (fbusb flash boot/recovery)
```

Why this one:
- **Linux by default** with no RTC re-arming tricks.
- **Two independent ways back to Android that bypass U-Boot**: the Vol+ menu → Recovery (needs no OS), and the RTC
  bit (one-shot, LK clears it before loading, so it self-heals). A broken, hung or corrupt U-Boot in `boot` costs at
  worst a menu press: LK's key poll runs before any image is loaded, and header errors reset after 8 s with the menu
  still reachable.
- **Android in normal mode** through U-Boot's `tbandroid` (proven in P1), with LK's patched stock DT (U-Boot carries
  the stock DTB, so LK patches an Android-shaped tree). When launched by the menu or the RTC bit, Android runs in LK
  recovery mode (`ro.boot.mode=recovery`), which worked on 2026-11-17 and is acceptable as an escape.
- **Dev loop**: U-Boot `fastboot boot`, no flashing to test kernels.

Requirements this places on U-Boot (none of them is LK work):
1. Image built per §4, gated by `lk_image_check.py`.
2. Handle LK bootmodes from `atag,boot`: **KPOC (8/9) and alarm (7) must go to Android** (stock charging UI), or
   power off. Linux now has a charger driver, but the stock charging UI is still the safer target.
3. Own the watchdog. LK leaves 10 s armed. U-Boot's `WDT_MTK` autostart (15 s) is fine, and the Linux kernel must
   take it over in turn.
4. Boot counter and fallback, kept in a raw record. Decided 2026-11-17: a dedicated 1 MiB `tbstate` partition
   carved from `userdata` ([plan-dualboot.md §2, §4](plan-dualboot.md)). Until then, the unused tail of `boot`
   would also work: LK only reads the header and the kernel area.
5. Never write `para`.

Open item from the handoff: Magisk "direct install" patches the partition Android booted from. With Android in
`recovery`, check what Magisk targets before updating it.

### Second choice: mainline Linux directly in `boot` (option C)

Simplest chain (LK → Linux). Android via the RTC bit only, always in LK recovery mode. No fallback before the
kernel's own init, no `fastboot boot`. `boot-mainline.img` already passes §4. Choose this only if U-Boot work stalls.

### Rejected

- Android in `boot`, Linux by RTC bit (today's Phase 1): Linux is never the default.
- BCB as a transport: persistent and disables the menu (§3.3).
- Replacing LK: unnecessary now that its contract is known.

---

## 8. Verification plan (Android-safe first, one hypothesis per flash)

Escapes, in order: power-cycle; Vol+ menu; LK fastboot + `fbusb`; BROM + mtkclient. Run `lk_image_check.py` on
every image before writing it.

| # | Layout | Action | Prediction | If wrong |
|---|---|---|---|---|
| **T0** reproduce | Android `boot`, **current** U-Boot `recovery` | From LK-booted Android, read ~1.5 GiB through the page cache (`dd if=$B/system of=/dev/null bs=1M count=1500`), then `adb reboot recovery` | LK logo + orange, no band, WDT reset, then **normal Android** (RTC bit already cleared) | If U-Boot starts, the stale-FDT mechanism is wrong; stop and re-analyse |
| **T0b** control | same | light session, `adb reboot recovery` | U-Boot | — |
| **T1** fix | Android `boot`, **padded** U-Boot `recovery` | repeat T0 (heavy I/O first) | U-Boot starts, `tbandroid` → Android | fix incomplete; Android comes back by itself |
| **T2** | same | Vol+ menu → Recovery | U-Boot | — |
| **T3** | **padded U-Boot `boot`**, Android `recovery` | cold power-on and plain `adb reboot`, each after heavy I/O | U-Boot → Android (from `recovery`, normal mode) | Vol+ → Recovery → Android, then restore |
| **T4** | same | U-Boot fastboot `fastboot boot` mainline; Linux default once `boot-target` logic exists | Linux | same escape |
| **T5** | same | charger plugged while off (KPOC) | Android charging UI via U-Boot (after requirement 2) | power off with the long press |

**Results, 2026-11-17** (the live table is in [plan-dualboot.md §8](plan-dualboot.md)):
- **T0 as first written** (old image, LK-launched Android, 1.5 GB read): **U-Boot started**. The prediction was
  wrong because an LK-launched kernel protects its FDT. That correction is now in §1.4.
- **T0 corrected** (old image, Android started by U-Boot, then 2.5 GB read): reproduced. No U-Boot; reset after
  34 s; Android came back on its own with `wdt_by_pass_pwk`, `hw_status: 5`.
- **T1** (padded image, the same sequence): **U-Boot fastboot after 13 s.**
- Found during T1: the freshly loaded DT carries `/firmware/android/mode = recovery`. `tbandroid` now patches it;
  Android reports `rtc` / `normal` and Magisk works.
- New U-Boot bug: `fastboot continue` resets the tablet. Use `fastboot reboot`.

---

## 9. Still unknown

- Whether the stock 3.18 kernel reserves the FDT region (§2 last row). Irrelevant once images meet §4.
- The physical key behind LK key code 1 (factory mode `0xb`). Avoid holding Vol− at power-on until known.
- The preloader's own boot-reason handling (not analysed; LK only reads its handshake at `0x41e66358`).

## 10. Address index

| Function / data | Address |
|---|---|
| `platform_init` | `0x41e01f0c` |
| `boot_mode_select` | `0x41e02c60` |
| boot menu | `0x41e05984` |
| BCB check (`boot-recovery`) / wrapper | `0x41e0555c` / `0x41e05c10` |
| `mboot_recovery_load_misc` (`para`, 0x1800 B, heap buffer) | `0x41e03d88` |
| RTC: recovery check / fastboot check / set recovery / set-clear fastboot | `0x41e0ce18` / `0x41e0cdf4` / `0x41e0ce70` / `0x41e0cdb0` |
| `rtc_boot_check` (clears recovery bit) | `0x41e0ca2c` |
| `bldr_load_dtb` | `0x41e1f20c` |
| bootopt parser | `0x41e1f18c` |
| `partition_read` | `0x41e1c5a8` |
| boot / recovery header loaders | `0x41e033b8` / `0x41e03694` |
| boot / recovery body loaders | `0x41e03924` / `0x41e03ad8` |
| verified boot + orange screen | `0x41e030d4`, `0x41e02f9c` |
| `mt_boot_init` | `0x41e205f0` region (calls `0x41e20308`) |
| `boot_linux_from_storage` | `0x41e20308` |
| `boot_linux_fdt` | `0x41e1f484` |
| gunzip / inflate | `0x41e207cc` / `0x41e2071c` |
| `jump_to_K64` / SMC | `0x41e1f444` / `0x41e1d424` |
| WDT init / disable / kick | `0x41e0c7cc` / `0x41e0c788` / `0x41e0c7bc` |
| `fastboot_init` | `0x41e20db8` |
| `g_boot_mode`, `boot_state`, `is_64bit`, `g_boot_hdr` | `0x41e58818`, `0x41e58830`, `0x41e6019c`, `0x41e60198` |

Reproduce the disassembly: `tools/venv` has capstone. Disassemble `lk.bin[0x200:0x200+0x57818]` as Thumb at
`0x41E00000`. `mainline/scripts/analysis/lk_disasm.py` / `lk_strrefs.py` cover ranges and string xrefs.

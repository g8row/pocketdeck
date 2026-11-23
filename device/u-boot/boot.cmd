# TB-7304X boot script (hush). build-uboot.sh makes it the U-Boot image's ramdisk; LK loads it to 0x44000000 and
# CONFIG_BOOTCOMMAND sources it. Edit and rebuild the image; no U-Boot recompile needed.
#
# The target comes from the boot record (`tbstate`, two copies in the `tbstate` partition; mainline/u-boot/tbstate.h,
# docs/mainline/plan-dualboot.md §4), written by Linux/Android with the `tbstate` tool:
#   oneshot (consumed here) > default (linux unless set to android)
# Always Android: LK bootmode 7/8/9 (RTC alarm, charger plugged in while off), a record that cannot be read or is
# corrupt, and Linux after more than `max` boots in a row that never reached "healthy" (stage 2 resets the count
# after 60 s).
# Linux, by the record's attempt count (taken before this boot is counted):
#   attempts <  max   the record's slot: a/b = raw Android-format image in tbkern_a/b, root on tbroot_a/b;
#                     cache = /cache/linux/boot-mainline-uboot.img with the root in /cache/linux/rootfs.img
#   attempts == max   tbrescue once (stage 1 stays in the initramfs: rescue shell, then Android after 300 s)
#   attempts >  max   Android until Linux is re-armed (`tbstate set attempts=0`, linux-test.sh to-linux)
# A raw slot that is not a valid image, or a bootm that returns, falls back to the cache image. The kernel learns
# what was booted from `tb.slot=a|b|cache|rescue` at the front of its cmdline (bootm prepends ${bootargs}).
# Android is read from ${android_part} (set by tb_lk_info from LK's boot mode: `recovery` while U-Boot is in
# `boot`). The only eMMC writes are `tbstate save` (the two record sectors).

setenv target linux
mmc dev 0
if tbstate load; then
	setenv target ${tb_default}
	if test "${tb_state}" = blank; then
		echo tb7304x: no boot record yet, creating one (default linux)
		tbstate save
	fi
	if test "${tb_state}" = corrupt; then
		echo tb7304x: boot record corrupt, rewriting it and booting Android
		tbstate fail corrupt
		tbstate save
		setenv target android
	fi
	if test "${tb_oneshot}" != none; then
		setenv target ${tb_oneshot}
		tbstate set oneshot none
		tbstate save
	fi
else
	echo tb7304x: boot record unreadable, booting Android
	setenv target android
fi
# Charger plugged in while off (LK KPOC, bootmode 8/9) and RTC alarm (7) always go to Android: its charging UI and
# alarm handling exist, Linux has neither. lk_bootmode is decimal (env_set_ulong).
if test "${lk_bootmode}" = 7 || test "${lk_bootmode}" = 8 || test "${lk_bootmode}" = 9; then setenv target android; fi
tbstate show
echo tb7304x: target ${target} (LK bootmode ${lk_bootmode}), Android in ${android_part}

if test "${target}" = "fastboot"; then
	echo tb7304x: fastboot usb 0 (fastboot boot <img> / fastboot continue = default target / fastboot reboot)
	fastboot usb 0
	setenv target ${tb_default}
	echo tb7304x: fastboot continue, booting the default target ${target}
fi

if test "${target}" = "linux"; then
	if test ${tb_attempts} -gt ${tb_max}; then
		echo tb7304x: Linux started ${tb_attempts} times without reaching healthy, booting Android
		tbstate fail attempts
		tbstate save
	else
		if test ${tb_attempts} -lt ${tb_max}; then setenv kslot ${tb_slot}; else setenv kslot rescue; fi
		tbstate attempt
		tbstate save
		setenv kpart none
		if test "${kslot}" = a || test "${kslot}" = b; then setenv kpart tbkern_${kslot}; fi
		if test "${kslot}" = rescue; then setenv kpart tbrescue; fi
		# raw slot: read the header page, check "ANDROID!", then read header + kernel + ramdisk + second
		# (sizes at 0x8/0x10/0x18) plus 16 KiB for the page padding, if that fits the partition. Hex throughout.
		setenv kok 0
		if test "${kpart}" != none; then
			if part start mmc 0 ${kpart} kstart && part size mmc 0 ${kpart} ksize && mmc read 0x50000000 ${kstart} 8; then
				if itest.l *0x50000000 -eq 0x52444e41 && itest.l *0x50000004 -eq 0x2144494f; then
					setexpr.l kn *0x50000008 + *0x50000010
					setexpr.l ks2 *0x50000018 + 0
					setexpr kn ${kn} + ${ks2}
					setexpr kn ${kn} / 200
					setexpr kn ${kn} + 20
					if itest ${kn} -le ${ksize} && mmc read 0x50000000 ${kstart} ${kn}; then setenv kok 1; fi
				fi
			fi
			if test ${kok} = 1; then
				echo tb7304x: booting Linux from ${kpart} (0x${kn} sectors)
				setenv bootargs tb.slot=${kslot}
				bootm 0x50000000
				tbstate fail bootm
			else
				echo tb7304x: no valid image in ${kpart}
				tbstate fail no-image
			fi
			tbstate save
		fi
		# the legacy image on cache: slot `cache`, and the fallback for a raw slot or tbrescue
		if test "${kslot}" != rescue; then setenv kslot cache; fi
		if load mmc 0#cache 0x50000000 linux/boot-mainline-uboot.img; then
			echo tb7304x: booting Linux from /cache/linux (tb.slot=${kslot})
			setenv bootargs tb.slot=${kslot}
			bootm 0x50000000
			tbstate fail bootm
		else
			tbstate fail no-image
		fi
		tbstate save
		echo tb7304x: no bootable Linux image, booting Android
	fi
fi

if part start mmc 0 ${android_part} abs && part size mmc 0 ${android_part} abn; then
	mmc read 0x50000000 ${abs} ${abn}
	tbandroid 0x50000000
fi

echo tb7304x: Android boot failed. fastboot usb 0 (fastboot boot <img> / fastboot reboot)
fastboot usb 0
sleep 10
reset

/* SPDX-License-Identifier: GPL-2.0 */
/*
 * Kernel API shims for the MediaTek WMT/BTIF/wlan_gen2 tree (written for <= 5.15) on Linux 7.0.
 * Force-included into every file of drivers/misc/mediatek by its top Makefile; only renames and
 * thin wrappers live here, real behaviour changes are edited in the driver sources.
 */
#ifndef _WCN_COMPAT_H_
#define _WCN_COMPAT_H_

#include <linux/version.h>
#include <linux/timer.h>
#include <linux/device.h>	/* pm_wakeup.h */
#include <linux/netdevice.h>
#include <linux/sched/clock.h>

/* timers: from_timer() became timer_container_of() (6.16), del_timer*() became timer_delete*() (6.15) */
#ifndef from_timer
#define from_timer(var, callback_timer, timer_fieldname) \
	timer_container_of(var, callback_timer, timer_fieldname)
#endif
#define del_timer(t)		timer_delete(t)
#define del_timer_sync(t)	timer_delete_sync(t)

/* wakeup sources: create/add and remove/destroy are no longer exported; register/unregister do both */
static inline struct wakeup_source *wcn_wakeup_source_create(const char *name)
{
	return wakeup_source_register(NULL, name);
}
#define wakeup_source_create(name)	wcn_wakeup_source_create(name)
#define wakeup_source_add(ws)		do { (void)(ws); } while (0)
#define wakeup_source_remove(ws)	do { (void)(ws); } while (0)
#define wakeup_source_destroy(ws)	wakeup_source_unregister(ws)

/* netif_rx() is safe from any context since 5.18 */
#define netif_rx_ni(skb)	netif_rx(skb)

#endif /* _WCN_COMPAT_H_ */

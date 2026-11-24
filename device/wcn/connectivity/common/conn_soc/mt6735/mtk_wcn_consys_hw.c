/*
 * Copyright (C) 2011-2014 MediaTek Inc.
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License version 2 as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 */

/*
 * MT6735 CONSYS platform layer for mainline Linux (TB-7304X, MT6737M + MT6625L).
 *
 * Power sequence from the MT6735 3.18 BSP (conn_soc/mt6735/mtk_wcn_consys_hw.c, Lenovo P1m tree), wired to
 * mainline services the way frank-w's MT7623 port does it:
 *   vendor clk "conn" (SPM MTCMOS + AXI bus protection)  -> pm_runtime on MT6735_POWER_DOMAIN_CONN
 *   vendor clk "bus"  (infra CONNMCU bus clock)          -> clock "bus" = <&infracfg CLK_INFRA_CONNMCU_BUS>
 *   pmic_set_register_value(..._ON_CTRL)                  -> MT6328 regmap through the pwrap device
 *   CONNSYS CPU SW reset (TOPRGU 0x10212018 [12], key 0x88) -> direct write, reg[1] of the consys node
 *   emi_mpu_set_region_protection()                        -> not done (no EMI MPU driver in mainline)
 *   clk_buf_ctrl(CLK_BUF_CONN)                             -> not done yet, see CONSYS_CLOCK_BUF_CTRL
 */

#ifdef DFT_TAG
#undef DFT_TAG
#endif
#define DFT_TAG "[WMT-CONSYS-HW]"

#include <linux/clk.h>
#include <linux/delay.h>
#include <linux/io.h>
#include <linux/of.h>
#include <linux/of_address.h>
#include <linux/of_platform.h>
#include <linux/of_reserved_mem.h>
#include <linux/pinctrl/consumer.h>
#include <linux/platform_device.h>
#include <linux/pm_runtime.h>
#include <linux/regmap.h>
#include <linux/regulator/consumer.h>
#include <linux/sizes.h>
#include "osal_typedef.h"
#include "mtk_wcn_consys_hw.h"

/* MT6328 LDO control registers (BSP mach/upmu_hw.h). *_ON_CTRL = 1: the LDO follows CONSYS' own request. */
#define MT6328_VCN28_CON0	0x0A0E
#define MT6328_VCN33_CON1	0x0A12	/* WIFI */
#define MT6328_VCN33_CON2	0x0A14	/* BT */
#define MT6328_VCN18_CON0	0x0A3A
#define MT6328_LDO_ON_CTRL	BIT(3)

#define CONSYS_CHIP_ID_OK(id)	((id) == 0x0321 || (id) == 0x0335 || (id) == 0x0337)

struct CONSYS_BASE_ADDRESS conn_reg;
static phys_addr_t gConEmiPhyBase;
static UINT8 __iomem *pEmibaseaddr;
static struct clk *clk_infra_conn_main;	/* infra CONNMCU bus clock */
static struct platform_device *my_pdev;
static struct regulator *reg_VCN18;
static struct regulator *reg_VCN28;
static struct regulator *reg_VCN33_BT;
static struct regulator *reg_VCN33_WIFI;
static struct pinctrl *consys_pinctrl;
static struct regmap *pmic_regmap;
#define DYNAMIC_DUMP_GROUP_NUM 5

static INT32 mtk_wmt_probe(struct platform_device *pdev);
static void mtk_wmt_remove(struct platform_device *pdev);

static const struct of_device_id apwmt_of_ids[] = {
	{.compatible = "mediatek,mt6735-consys"},
	{}
};
MODULE_DEVICE_TABLE(of, apwmt_of_ids);

static struct platform_driver mtk_wmt_dev_drv = {
	.probe = mtk_wmt_probe,
	.remove = mtk_wmt_remove,
	.driver = {
		   .name = "mt6735consys",
		   .of_match_table = apwmt_of_ids,
		   },
};

static VOID consys_pmic_on_ctrl(UINT32 reg, UINT32 hw_ctrl)
{
	INT32 ret;

	if (!pmic_regmap)
		return;
	ret = regmap_update_bits(pmic_regmap, reg, MT6328_LDO_ON_CTRL, hw_ctrl ? MT6328_LDO_ON_CTRL : 0);
	if (ret)
		WMT_PLAT_ERR_FUNC("PMIC 0x%04x ON_CTRL=%d failed (%d)\n", reg, hw_ctrl, ret);
}

static struct regulator *consys_regulator_get(struct device *dev, const char *id)
{
	struct regulator *r = devm_regulator_get(dev, id);

	if (IS_ERR(r)) {
		WMT_PLAT_ERR_FUNC("regulator %s: %ld\n", id, PTR_ERR(r));
		return NULL;
	}
	return r;
}

static VOID consys_regulator_on(struct regulator *r, INT32 uV, const char *name)
{
	if (!r)
		return;
	if (uV)
		regulator_set_voltage(r, uV, uV);
	if (regulator_enable(r))
		WMT_PLAT_ERR_FUNC("enable %s failed\n", name);
}

static VOID consys_regulator_off(struct regulator *r, const char *name)
{
	if (r && regulator_disable(r))
		WMT_PLAT_ERR_FUNC("disable %s failed\n", name);
}

static INT32 mtk_wmt_probe(struct platform_device *pdev)
{
	struct device_node *node;
	struct platform_device *pwrap;

	my_pdev = pdev;
	pm_runtime_enable(&pdev->dev);

	/* The MT6328 sits behind the PMIC wrapper; its regmap belongs to the pwrap device. */
	node = of_parse_phandle(pdev->dev.of_node, "mediatek,pwrap-regmap", 0);
	if (node) {
		pwrap = of_find_device_by_node(node);
		of_node_put(node);
		if (pwrap) {
			pmic_regmap = dev_get_regmap(&pwrap->dev, NULL);
			put_device(&pwrap->dev);
		}
	}
	if (!pmic_regmap)
		WMT_PLAT_ERR_FUNC("no PMIC regmap (mediatek,pwrap-regmap), LDO ON_CTRL left alone\n");

	clk_infra_conn_main = devm_clk_get(&pdev->dev, "bus");
	if (IS_ERR(clk_infra_conn_main)) {
		WMT_PLAT_ERR_FUNC("[CCF]cannot get clk_infra_conn_main clock.\n");
		return PTR_ERR(clk_infra_conn_main);
	}

	reg_VCN18 = consys_regulator_get(&pdev->dev, "vcn18");
	reg_VCN28 = consys_regulator_get(&pdev->dev, "vcn28");
	reg_VCN33_BT = consys_regulator_get(&pdev->dev, "vcn33_bt");
	reg_VCN33_WIFI = consys_regulator_get(&pdev->dev, "vcn33_wifi");

	consys_pinctrl = devm_pinctrl_get(&pdev->dev);
	if (IS_ERR(consys_pinctrl)) {
		WMT_PLAT_ERR_FUNC("no consys pinctrl (%ld)\n", PTR_ERR(consys_pinctrl));
		consys_pinctrl = NULL;
	}

	WMT_PLAT_INFO_FUNC("probed: EMI 0x%llx, regmap %s\n", (unsigned long long)gConEmiPhyBase,
			   pmic_regmap ? "ok" : "missing");
	return 0;
}

static void mtk_wmt_remove(struct platform_device *pdev)
{
	pm_runtime_disable(&pdev->dev);
	my_pdev = NULL;
}

static VOID consys_cpu_reset(UINT32 assert)
{
	UINT32 v = CONSYS_REG_READ(conn_reg.ap_rgu_base + CONSYS_CPU_SW_RST_OFFSET);

	v = assert ? (v | CONSYS_CPU_SW_RST_BIT) : (v & ~CONSYS_CPU_SW_RST_BIT);
	CONSYS_REG_WRITE(conn_reg.ap_rgu_base + CONSYS_CPU_SW_RST_OFFSET, (v & 0x00ffffff) | CONSYS_CPU_SW_RST_CTRL_KEY);
}

INT32 mtk_wcn_consys_hw_reg_ctrl(UINT32 on, UINT32 co_clock_type)
{
	INT32 iRet;
	UINT32 retry = 10;
	UINT32 consysHwChipId = 0;

	if (!my_pdev) {
		WMT_PLAT_ERR_FUNC("consys platform device not probed\n");
		return -1;
	}
	WMT_PLAT_WARN_FUNC("CONSYS-HW-REG-CTRL(0x%08x), co_clock(%d) start\n", on, co_clock_type);

	if (on) {
		/* 1. VCN18 on, SW controlled */
		consys_pmic_on_ctrl(MT6328_VCN18_CON0, 0);
		consys_regulator_on(reg_VCN18, 1800000, "VCN18");
		udelay(150);

		if (co_clock_type) {
			/* co-clock: 26 MHz from the RF clock buffer; VCN28 only when FM/GPS run */
			WMT_PLAT_INFO_FUNC("co clock type(%d), clk buf not controlled (not ported)\n", co_clock_type);
			consys_pmic_on_ctrl(MT6328_VCN28_CON0, 0);
		} else {
			consys_pmic_on_ctrl(MT6328_VCN28_CON0, 1);
			consys_regulator_on(reg_VCN28, 2800000, "VCN28");
		}

		/* 3. assert CONNSYS CPU SW reset, then power the CONN MTCMOS (SPM sequence + AXI protection) */
		consys_cpu_reset(1);
		CONSYS_REG_WRITE(conn_reg.spm_base + CONSYS_PWRON_CONFG_EN_OFFSET, CONSYS_PWRON_CONFG_EN_VALUE);
		iRet = pm_runtime_resume_and_get(&my_pdev->dev);
		if (iRet)
			WMT_PLAT_ERR_FUNC("CONN power domain on failed (%d)\n", iRet);

		/* 11. 26M is ready now, delay 10us for mem_pd de-assert; then the CONNMCU bus clock */
		udelay(10);
		iRet = clk_prepare_enable(clk_infra_conn_main);
		if (iRet)
			WMT_PLAT_ERR_FUNC("clk_prepare_enable(clk_infra_conn_main) fail(%d)\n", iRet);

		/* 12. poll the CONSYS chip id, 0x18070008 */
		while (retry-- > 0) {
			consysHwChipId = CONSYS_REG_READ(conn_reg.mcu_base + CONSYS_CHIP_ID_OFFSET);
			if (CONSYS_CHIP_ID_OK(consysHwChipId)) {
				WMT_PLAT_INFO_FUNC("retry(%d) consys chipId(0x%08x)\n", retry, consysHwChipId);
				break;
			}
			WMT_PLAT_ERR_FUNC("Read CONSYS chipId(0x%08x)\n", consysHwChipId);
			msleep(20);
		}
		if (!CONSYS_CHIP_ID_OK(consysHwChipId)) {
			WMT_PLAT_ERR_FUNC("consys power on issue, chipId(0x%08x)\n", consysHwChipId);
			WMT_PLAT_ERR_FUNC("CPU_SW_RST(0x%x) PWR_ACK(0x%x) PWR_ACK_S(0x%x) TOP1_PWR_CTRL(0x%x)\n",
					  CONSYS_REG_READ(conn_reg.ap_rgu_base + CONSYS_CPU_SW_RST_OFFSET),
					  CONSYS_REG_READ(conn_reg.spm_base + CONSYS_PWR_CONN_ACK_OFFSET),
					  CONSYS_REG_READ(conn_reg.spm_base + CONSYS_PWR_CONN_ACK_S_OFFSET),
					  CONSYS_REG_READ(conn_reg.spm_base + CONSYS_TOP1_PWR_CTRL_OFFSET));
		}

		/* 14. real speed MBIST: ACR 0x18070110[18] = 1 */
		CONSYS_REG_WRITE(conn_reg.mcu_base + CONSYS_MCU_CFG_ACR_OFFSET,
				 CONSYS_REG_READ(conn_reg.mcu_base + CONSYS_MCU_CFG_ACR_OFFSET) |
				 CONSYS_MCU_CFG_ACR_MBIST_BIT);

		/* 16. deassert CONNSYS CPU SW reset */
		consys_cpu_reset(0);
		msleep(20);
	} else {
		clk_disable_unprepare(clk_infra_conn_main);
		iRet = pm_runtime_put_sync(&my_pdev->dev);
		if (iRet < 0)
			WMT_PLAT_ERR_FUNC("CONN power domain off failed (%d)\n", iRet);

		if (!co_clock_type) {
			consys_pmic_on_ctrl(MT6328_VCN28_CON0, 0);
			consys_regulator_off(reg_VCN28, "VCN28");
		}
		consys_pmic_on_ctrl(MT6328_VCN18_CON0, 0);
		consys_regulator_off(reg_VCN18, "VCN18");
	}
	WMT_PLAT_WARN_FUNC("CONSYS-HW-REG-CTRL(0x%08x), finish\n", on);
	return 0;
}

INT32 mtk_wcn_consys_hw_gpio_ctrl(UINT32 on)
{
	INT32 iRet = 0;

	if (on) {
		iRet += wmt_plat_eirq_ctrl(PIN_BGF_EINT, PIN_STA_INIT);
		iRet += wmt_plat_eirq_ctrl(PIN_BGF_EINT, PIN_STA_EINT_DIS);
		WMT_PLAT_DBG_FUNC("CONSYS-HW, BGF IRQ registered and disabled\n");
	} else {
		iRet += wmt_plat_eirq_ctrl(PIN_BGF_EINT, PIN_STA_EINT_DIS);
		iRet += wmt_plat_eirq_ctrl(PIN_BGF_EINT, PIN_STA_DEINIT);
		WMT_PLAT_DBG_FUNC("CONSYS-HW, BGF IRQ unregistered and disabled\n");
	}
	return iRet;
}

/* The core passes co_clock_type on power on only; remember it for power off. */
static UINT32 consys_co_clock_type;

INT32 mtk_wcn_consys_hw_pwr_on(UINT32 co_clock_type)
{
	INT32 iRet = 0;

	WMT_PLAT_INFO_FUNC("CONSYS-HW-PWR-ON, start\n");
	consys_co_clock_type = co_clock_type;
	iRet += mtk_wcn_consys_hw_reg_ctrl(1, co_clock_type);
	iRet += mtk_wcn_consys_hw_gpio_ctrl(1);
	WMT_PLAT_INFO_FUNC("CONSYS-HW-PWR-ON, finish(%d)\n", iRet);
	return iRet;
}

INT32 mtk_wcn_consys_hw_pwr_off(VOID)
{
	INT32 iRet = 0;

	WMT_PLAT_INFO_FUNC("CONSYS-HW-PWR-OFF, start\n");
	iRet += mtk_wcn_consys_hw_reg_ctrl(0, consys_co_clock_type);
	iRet += mtk_wcn_consys_hw_gpio_ctrl(0);
	WMT_PLAT_INFO_FUNC("CONSYS-HW-PWR-OFF, finish(%d)\n", iRet);
	return iRet;
}

INT32 mtk_wcn_consys_hw_rst(UINT32 co_clock_type)
{
	INT32 iRet = 0;

	WMT_PLAT_INFO_FUNC("CONSYS-HW, hw_rst start, eirq should be disabled before this step\n");
	iRet += mtk_wcn_consys_hw_reg_ctrl(0, co_clock_type);
	iRet += mtk_wcn_consys_hw_reg_ctrl(1, co_clock_type);
	WMT_PLAT_INFO_FUNC("CONSYS-HW, hw_rst finish, eirq should be enabled after this step\n");
	return iRet;
}

/* VCN33 BT/WIFI: SW enable, then hand the LDO to CONSYS (ON_CTRL = 1) */
INT32 mtk_wcn_consys_hw_bt_paldo_ctrl(UINT32 enable)
{
	if (enable) {
		consys_regulator_on(reg_VCN33_BT, 3300000, "VCN33_BT");
		consys_pmic_on_ctrl(MT6328_VCN33_CON2, 1);
	} else {
		consys_pmic_on_ctrl(MT6328_VCN33_CON2, 0);
		consys_regulator_off(reg_VCN33_BT, "VCN33_BT");
	}
	WMT_PLAT_INFO_FUNC("WMT do BT PMIC %s\n", enable ? "on" : "off");
	return 0;
}

INT32 mtk_wcn_consys_hw_wifi_paldo_ctrl(UINT32 enable)
{
	if (enable) {
		consys_regulator_on(reg_VCN33_WIFI, 3300000, "VCN33_WIFI");
		consys_pmic_on_ctrl(MT6328_VCN33_CON1, 1);
	} else {
		consys_pmic_on_ctrl(MT6328_VCN33_CON1, 0);
		consys_regulator_off(reg_VCN33_WIFI, "VCN33_WIFI");
	}
	WMT_PLAT_INFO_FUNC("WMT do WIFI PMIC %s\n", enable ? "on" : "off");
	return 0;
}
EXPORT_SYMBOL(mtk_wcn_consys_hw_wifi_paldo_ctrl);

INT32 mtk_wcn_consys_hw_vcn28_ctrl(UINT32 enable)
{
	/* co-clock mode: VCN28 is needed only while FM/GPS run */
	if (enable)
		consys_regulator_on(reg_VCN28, 2800000, "VCN28");
	else
		consys_regulator_off(reg_VCN28, "VCN28");
	WMT_PLAT_INFO_FUNC("turn %s vcn28 for fm/gps usage in co-clock mode\n", enable ? "on" : "off");
	return 0;
}

INT32 mtk_wcn_consys_hw_state_show(VOID)
{
	return 0;
}

/* Map the CONSYS EMI window (reserved-memory) and point CONSYS' EMI remap register at it. */
static INT32 consys_emi_setup(VOID)
{
	UINT32 addrPhy;

	if (!gConEmiPhyBase) {
		WMT_PLAT_ERR_FUNC("consys emi memory address gConEmiPhyBase invalid\n");
		return -1;
	}
	/*
	 * The remap ignores address bit 20: a base that is only 1 MB aligned makes CONSYS write 1 MB below the
	 * reservation (seen on the TB-7304X: firmware trace text in the kernel page tables). Stock DT: 2 MB alignment.
	 */
	if (gConEmiPhyBase & (SZ_2M - 1)) {
		WMT_PLAT_ERR_FUNC("consys EMI base 0x%llx is not 2 MB aligned, refusing\n",
				  (unsigned long long)gConEmiPhyBase);
		gConEmiPhyBase = 0;
		return -1;
	}
	/*
	 * consys to ap emi remapping register 0x10000320: [11:0] = base >> 20, [12] = enable. The BSP ORs the value
	 * in, which keeps stale bits from a previous setting; replace the field instead.
	 */
	addrPhy = ((gConEmiPhyBase & 0xFFF00000) >> 20) | 0x1000;
	CONSYS_REG_WRITE(conn_reg.topckgen_base + CONSYS_EMI_MAPPING_OFFSET,
			 (CONSYS_REG_READ(conn_reg.topckgen_base + CONSYS_EMI_MAPPING_OFFSET) & ~0x1FFF) | addrPhy);
	WMT_PLAT_INFO_FUNC("EMI 0x%llx, CONSYS_EMI_MAPPING(0x%08x)\n", (unsigned long long)gConEmiPhyBase,
			   CONSYS_REG_READ(conn_reg.topckgen_base + CONSYS_EMI_MAPPING_OFFSET));

	if (!pEmibaseaddr)
		pEmibaseaddr = ioremap(gConEmiPhyBase + CONSYS_EMI_AP_PHY_OFFSET, CONSYS_EMI_MEM_SIZE);
	if (!pEmibaseaddr) {
		WMT_PLAT_ERR_FUNC("EMI mapping fail\n");
		return -1;
	}
	memset_io(pEmibaseaddr, 0, CONSYS_EMI_MEM_SIZE);
	return 0;
}

INT32 mtk_wcn_consys_hw_restore(struct device *device)
{
	return consys_emi_setup();
}

/* Reserved memory by device tree (dynamic: size + alignment, as in the stock DT) */
static int reserve_memory_consys_fn(struct reserved_mem *rmem)
{
	pr_info("[WMT-CONSYS-HW] reserved memory %s: base 0x%llx, size 0x%llx\n", rmem->name,
		(unsigned long long)rmem->base, (unsigned long long)rmem->size);
	gConEmiPhyBase = rmem->base;
	return 0;
}
RESERVEDMEM_OF_DECLARE(reserve_memory_consys, "mediatek,consys-reserve-memory", reserve_memory_consys_fn);

INT32 mtk_wcn_consys_hw_init(void)
{
	INT32 iRet;
	struct device_node *node;

	node = of_find_compatible_node(NULL, NULL, "mediatek,mt6735-consys");
	if (!node) {
		WMT_PLAT_ERR_FUNC("[%s] can't find CONSYS compatible node\n", __func__);
		return -1;
	}
	/* reg order as in the stock DT: CONN_MCU_CONFIG, AP_RGU (TOPRGU), TOPCKGEN, SPM */
	conn_reg.mcu_base = (SIZE_T) of_iomap(node, 0);
	conn_reg.ap_rgu_base = (SIZE_T) of_iomap(node, 1);
	conn_reg.topckgen_base = (SIZE_T) of_iomap(node, 2);
	conn_reg.spm_base = (SIZE_T) of_iomap(node, 3);
	of_node_put(node);
	if (!conn_reg.mcu_base || !conn_reg.ap_rgu_base || !conn_reg.topckgen_base || !conn_reg.spm_base) {
		WMT_PLAT_ERR_FUNC("consys register mapping failed\n");
		return -1;
	}

	iRet = consys_emi_setup();

	iRet = platform_driver_register(&mtk_wmt_dev_drv);
	if (iRet)
		WMT_PLAT_ERR_FUNC("WMT platform driver registered failed(%d)\n", iRet);
	return iRet;
}

INT32 mtk_wcn_consys_hw_deinit(void)
{
	if (pEmibaseaddr) {
		iounmap(pEmibaseaddr);
		pEmibaseaddr = NULL;
	}
	platform_driver_unregister(&mtk_wmt_dev_drv);
	return 0;
}

UINT8 *mtk_wcn_consys_emi_virt_addr_get(UINT32 ctrl_state_offset)
{
	if (!pEmibaseaddr) {
		WMT_PLAT_ERR_FUNC("EMI base address is NULL\n");
		return NULL;
	}
	return pEmibaseaddr + ctrl_state_offset;
}

UINT32 mtk_wcn_consys_soc_chipid(void)
{
	return PLATFORM_SOC_CHIP;
}

struct pinctrl *mtk_wcn_consys_get_pinctrl(VOID)
{
	return consys_pinctrl;
}

INT32 mtk_wcn_consys_set_dynamic_dump(PUINT32 str_buf)
{
	PUINT8 vir_addr = mtk_wcn_consys_emi_virt_addr_get(EXP_APMEM_CTRL_CHIP_DYNAMIC_DUMP);

	if (!vir_addr) {
		WMT_PLAT_ERR_FUNC("get vir address fail\n");
		return -2;
	}
	memcpy_toio(vir_addr, str_buf, DYNAMIC_DUMP_GROUP_NUM * 8);
	WMT_PLAT_INFO_FUNC("dynamic dump register value(0x%08x)\n", CONSYS_REG_READ(vir_addr));
	return 0;
}

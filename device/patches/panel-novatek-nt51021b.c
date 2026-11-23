// SPDX-License-Identifier: GPL-2.0-only
/*
 * Novatek NT51021B 600x1024 MIPI-DSI video-mode panel, as fitted to the Lenovo Tab 7 Essential TB-7304X
 * ("nt51021b_dsi_vdo_gx" in the stock firmware).
 *
 * Mode, power/reset sequence and the init command list were recovered from the stock 3.18 kernel and LK
 * (docs/mainline/research-display.md) and cross-checked against the DSI registers LK leaves programmed:
 * burst video, 4 lanes, VSA/VBP/VFP 2/25/35. All commands are 1-parameter short writes (MTK dsi_set_cmdq_V2
 * with count 1 = DCS short write with parameter).
 */
#include <linux/delay.h>
#include <linux/gpio/consumer.h>
#include <linux/mod_devicetable.h>
#include <linux/module.h>
#include <linux/regulator/consumer.h>

#include <drm/drm_mipi_dsi.h>
#include <drm/drm_modes.h>
#include <drm/drm_panel.h>
#include <drm/drm_probe_helper.h>

struct nt51021b {
	struct drm_panel panel;
	struct mipi_dsi_device *dsi;
	struct regulator *power;
	struct gpio_desc *reset;	/* active low: 1 = held in reset */
};

static inline struct nt51021b *to_nt51021b(struct drm_panel *panel)
{
	return container_of(panel, struct nt51021b, panel);
}

static int nt51021b_prepare(struct drm_panel *panel)
{
	struct nt51021b *ctx = to_nt51021b(panel);
	struct mipi_dsi_multi_context dsi_ctx = { .dsi = ctx->dsi };
	int ret;

	/* stock lcm_init_power: reset low, 20 ms, power on, 20 ms */
	gpiod_set_value_cansleep(ctx->reset, 1);
	msleep(20);
	ret = regulator_enable(ctx->power);
	if (ret)
		return ret;
	msleep(20);

	/* stock lcm_init reset dance (raw levels 0/1/0/1) */
	gpiod_set_value_cansleep(ctx->reset, 1);
	msleep(20);
	gpiod_set_value_cansleep(ctx->reset, 0);
	msleep(60);
	gpiod_set_value_cansleep(ctx->reset, 1);
	msleep(30);
	gpiod_set_value_cansleep(ctx->reset, 0);
	msleep(200);

	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x83, 0x00);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x84, 0x00);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x84, 0x00);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x85, 0x04);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x86, 0x08);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x8c, 0x8e);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0xc5, 0x2b);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0xc7, 0x2b);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x85, 0x04);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x86, 0x08);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x83, 0xaa);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x84, 0x11);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x9c, 0x10);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0xa9, 0x4b);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x83, 0x00);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0x84, 0x00);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0xfd, 0x5b);
	mipi_dsi_dcs_write_seq_multi(&dsi_ctx, 0xfa, 0x14);
	mipi_dsi_dcs_exit_sleep_mode_multi(&dsi_ctx);
	mipi_dsi_msleep(&dsi_ctx, 120);
	mipi_dsi_dcs_set_display_on_multi(&dsi_ctx);
	mipi_dsi_msleep(&dsi_ctx, 20);

	if (dsi_ctx.accum_err) {
		gpiod_set_value_cansleep(ctx->reset, 1);
		regulator_disable(ctx->power);
	}
	return dsi_ctx.accum_err;
}

static int nt51021b_unprepare(struct drm_panel *panel)
{
	struct nt51021b *ctx = to_nt51021b(panel);
	struct mipi_dsi_multi_context dsi_ctx = { .dsi = ctx->dsi };

	mipi_dsi_dcs_set_display_off_multi(&dsi_ctx);
	mipi_dsi_msleep(&dsi_ctx, 50);
	mipi_dsi_dcs_enter_sleep_mode_multi(&dsi_ctx);
	mipi_dsi_msleep(&dsi_ctx, 120);

	gpiod_set_value_cansleep(ctx->reset, 1);
	msleep(20);
	regulator_disable(ctx->power);
	return 0;
}

/*
 * GX timings. The pixel clock is chosen so that the MTK DSI link runs at the stock 336 Mb/s per lane
 * (clock * 24 bpp / 4 lanes). With LK's porches (VFP 35) that is 65.9 Hz; the vertical front porch is
 * stretched to 141 lines instead so the panel refreshes at 60.0 Hz (56 MHz / (783 x 1192)), matching
 * userspace that animates on a 60 Hz clock, with the same link rate.
 */
static const struct drm_display_mode nt51021b_gx_mode = {
	.clock = 56000,
	.hdisplay = 600,
	.hsync_start = 600 + 85,
	.hsync_end = 600 + 85 + 13,
	.htotal = 600 + 85 + 13 + 85,
	.vdisplay = 1024,
	.vsync_start = 1024 + 141,
	.vsync_end = 1024 + 141 + 2,
	.vtotal = 1024 + 141 + 2 + 25,
	.width_mm = 90,
	.height_mm = 154,
	.type = DRM_MODE_TYPE_DRIVER | DRM_MODE_TYPE_PREFERRED,
};

static int nt51021b_get_modes(struct drm_panel *panel, struct drm_connector *connector)
{
	return drm_connector_helper_get_modes_fixed(connector, &nt51021b_gx_mode);
}

static const struct drm_panel_funcs nt51021b_funcs = {
	.prepare = nt51021b_prepare,
	.unprepare = nt51021b_unprepare,
	.get_modes = nt51021b_get_modes,
};

static int nt51021b_probe(struct mipi_dsi_device *dsi)
{
	struct device *dev = &dsi->dev;
	struct nt51021b *ctx;
	int ret;

	ctx = devm_drm_panel_alloc(dev, struct nt51021b, panel, &nt51021b_funcs,
				   DRM_MODE_CONNECTOR_DSI);
	if (IS_ERR(ctx))
		return PTR_ERR(ctx);

	ctx->power = devm_regulator_get(dev, "power");
	if (IS_ERR(ctx->power))
		return dev_err_probe(dev, PTR_ERR(ctx->power), "failed to get power supply\n");

	/* LK left the panel running: don't glitch reset until prepare() */
	ctx->reset = devm_gpiod_get(dev, "reset", GPIOD_ASIS);
	if (IS_ERR(ctx->reset))
		return dev_err_probe(dev, PTR_ERR(ctx->reset), "failed to get reset gpio\n");

	ctx->dsi = dsi;
	mipi_dsi_set_drvdata(dsi, ctx);

	dsi->lanes = 4;
	dsi->format = MIPI_DSI_FMT_RGB888;
	dsi->mode_flags = MIPI_DSI_MODE_VIDEO | MIPI_DSI_MODE_VIDEO_BURST | MIPI_DSI_MODE_LPM;

	ret = drm_panel_of_backlight(&ctx->panel);
	if (ret)
		return dev_err_probe(dev, ret, "failed to get backlight\n");

	drm_panel_add(&ctx->panel);

	ret = devm_mipi_dsi_attach(dev, dsi);
	if (ret) {
		drm_panel_remove(&ctx->panel);
		return dev_err_probe(dev, ret, "failed to attach to DSI host\n");
	}
	return 0;
}

static void nt51021b_remove(struct mipi_dsi_device *dsi)
{
	struct nt51021b *ctx = mipi_dsi_get_drvdata(dsi);

	drm_panel_remove(&ctx->panel);
}

static const struct of_device_id nt51021b_of_match[] = {
	{ .compatible = "lenovo,tb7304x-nt51021b-gx" },
	{ }
};
MODULE_DEVICE_TABLE(of, nt51021b_of_match);

static struct mipi_dsi_driver nt51021b_driver = {
	.driver = {
		.name = "panel-novatek-nt51021b",
		.of_match_table = nt51021b_of_match,
	},
	.probe = nt51021b_probe,
	.remove = nt51021b_remove,
};
module_mipi_dsi_driver(nt51021b_driver);

MODULE_DESCRIPTION("Novatek NT51021B (Lenovo TB-7304X GX) DSI panel driver");
MODULE_LICENSE("GPL");

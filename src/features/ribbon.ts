import type { Plugin } from "obsidian";
import { UI, type PluginContext } from "../core";
import { openGuidebookSidebarWithStickyNote } from "./sidebar";
import { activateMapView } from "./map";

// 注册ribbon功能，用于打开设定侧边栏和便签侧边栏
export function registerRibbonFeature(plugin: Plugin, ctx: PluginContext): void {
	plugin.addRibbonIcon(
		UI.ICON.PLUGIN,
		ctx.t("ribbon.tooltip"),
		() => {
			void openGuidebookSidebarWithStickyNote(plugin, ctx);
		});

	plugin.addRibbonIcon(
		UI.ICON.MAP,
		"打开地图",
		() => {
			void activateMapView(plugin, ctx);
		}
	)
}


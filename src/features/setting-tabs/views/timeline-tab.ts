import { Setting, type App } from "obsidian";
import { addCustomType, deleteCustomType, isDefaultTypeKey, resolveTimelineCustomTypes, resolveTimelineTypeOptions, resolveTypeOptionTitle, updateCustomTypeSettings } from "../../../core";
import { TimelineRepository } from "../../../features/timeline/repository";
import { createSettingsSectionHeading } from "./heading";
import type { SettingsTabRenderContext } from "./types";
import { renderTypeConfigGroup } from "./custom-config-groups";

const timelineRepositoryByApp = new WeakMap<App, TimelineRepository>();

export function renderTimelineSettings(containerEl: HTMLElement, deps: SettingsTabRenderContext): void {
	const { ctx, refresh } = deps;
	const panelEl = containerEl.createDiv({ cls: "cna-settings-panel" });
	const repository = getTimelineRepository(ctx.app);
	createSettingsSectionHeading(panelEl, ctx.t("settings.timeline.section.main"));

	new Setting(panelEl)
		.setName(ctx.t("settings.timeline.enable.name"))
		.setDesc(ctx.t("settings.timeline.enable.desc"))
		.setClass("cna-settings-item")
		.addToggle((toggle) =>
			toggle.setValue(ctx.settings.timelineEnabled).onChange(async (value) => {
				await ctx.setSettings({ timelineEnabled: value });
				refresh();
			}),
		);

	const typeOptions = resolveTimelineTypeOptions(ctx.settings.timelineCustomTypes);
	renderTypeConfigGroup({
		app: ctx.app,
		panelEl,
		sectionTitle: ctx.t("settings.timeline.section.custom_types"),
		disabled: !ctx.settings.timelineEnabled,
		restoreDefaultsName: ctx.t("settings.timeline.restore_defaults.name"),
		restoreDefaultsDesc: ctx.t("settings.timeline.restore_defaults.desc"),
		restoreDefaultsLabel: ctx.t("settings.common.restore_defaults"),
		restoreDefaultsConfirmText: ctx.t("settings.common.confirm"),
		restoreDefaultsCancelText: ctx.t("settings.common.cancel"),
		labelInputPlaceholder: ctx.t("settings.timeline.type.label_placeholder"),
		colorInputPlaceholder: "#4A86E9",
		items: typeOptions.map((option, index) => {
			return{
				key: option.key,
				name: ctx.t("settings.timeline.type.name") + String(index + 1),
				label: resolveTypeOptionTitle(option, (key) => ctx.t(key)),
				colorHex: option.colorHex,
			};
		}),
		addTypeLabel: ctx.t("settings.timeline.add_type"),
		addTypeDesc: ctx.t("settings.timeline.add_type.desc"),
		deleteTypeLabel: ctx.t("settings.timeline.delete_type"),
		deleteTypeConfirmTitle: ctx.t("settings.timeline.delete_type.confirm.title"),
		deleteTypeConfirmMessage: ctx.t("settings.timeline.delete_type.confirm.message"),
		onLabelChange: async (key, label) => {
			const nextTypes = updateCustomTypeSettings(ctx.settings.timelineCustomTypes, key, resolveTimelineCustomTypes, (item) => {
				item.label = label;
			});
			await ctx.setSettings({ timelineCustomTypes: nextTypes });
		},
		onColorChange: async (key, colorHex) => {
			const previousTypes = resolveTimelineCustomTypes(ctx.settings.timelineCustomTypes);
			const nextTypes = updateCustomTypeSettings(previousTypes, key, resolveTimelineCustomTypes, (item) => {
				item.colorHex = colorHex;
			});
			await ctx.setSettings({ timelineCustomTypes: nextTypes });
			await repository.remapTypeColors(ctx.settings, previousTypes, nextTypes);
		},
		onRestoreDefaults: async () => {
			const previousTypes = resolveTimelineCustomTypes(ctx.settings.timelineCustomTypes);
			const nextTypes = resolveTimelineCustomTypes(undefined);
			await ctx.setSettings({ timelineCustomTypes: nextTypes });
			await repository.remapTypeColors(ctx.settings, previousTypes, nextTypes);
			refresh();
		},
		isDefaultKey: (key)=>isDefaultTypeKey(key,"timeline"),
		onAddType: async () => {
			const nextTypes = addCustomType(
				ctx.settings.timelineCustomTypes,
				resolveTimelineCustomTypes
			)
			await ctx.setSettings({ timelineCustomTypes: nextTypes });
			refresh();
		},
		onDeleteType: async (key) => {
			const preTypes = resolveTimelineCustomTypes(ctx.settings.timelineCustomTypes);
			const nextTypes = deleteCustomType(
				preTypes,
				key,
				resolveTimelineCustomTypes
			);
			await ctx.setSettings({ timelineCustomTypes: nextTypes });
			await repository.remapTypeColors(ctx.settings, preTypes, nextTypes);
			refresh();
		}
	});
}

function getTimelineRepository(app: App): TimelineRepository {
	const cached = timelineRepositoryByApp.get(app);
	if (cached) {
		return cached;
	}
	const repository = new TimelineRepository(app);
	timelineRepositoryByApp.set(app, repository);
	return repository;
}


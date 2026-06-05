import { Setting } from "obsidian";
import { resolveAnnotationCustomTypes, resolveAnnotationTypeOptions, resolveTypeOptionTitle, updateCustomTypeSettings,addCustomType,deleteCustomType, isDefaultTypeKey } from "../../../core";
import { getAnnotationRepository } from "../../../features/annotation/repository";
import { createSettingsSectionHeading } from "./heading";
import type { SettingsTabRenderContext } from "./types";
import { renderTypeConfigGroup } from "./custom-config-groups";

export function renderAnnotationSettings(containerEl: HTMLElement, deps: SettingsTabRenderContext): void {
	const { ctx, refresh } = deps;
	const panelEl = containerEl.createDiv({ cls: "cna-settings-panel" });
	const repository = getAnnotationRepository(ctx.app);
	createSettingsSectionHeading(panelEl, ctx.t("settings.annotation.section.main"));

	new Setting(panelEl)
		.setName(ctx.t("settings.annotation.enable.name"))
		.setDesc(ctx.t("settings.annotation.enable.desc"))
		.setClass("cna-settings-item")
		.addToggle((toggle) =>
			toggle.setValue(ctx.settings.annotationEnabled).onChange(async (value) => {
				await ctx.setSettings({ annotationEnabled: value });
				refresh();
			}),
		);

	new Setting(panelEl)
		.setName(ctx.t("settings.annotation.auto_locate.name"))
		.setDesc(ctx.t("settings.annotation.auto_locate.desc"))
		.setClass("cna-settings-item")
		.setDisabled(!ctx.settings.annotationEnabled)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.annotationAutoLocateOnFileSwitch)
				.setDisabled(!ctx.settings.annotationEnabled)
				.onChange(async (value) => {
					await ctx.setSettings({ annotationAutoLocateOnFileSwitch: value });
				}),
		);

	const typeOptions = resolveAnnotationTypeOptions(ctx.settings.annotationCustomTypes);
	renderTypeConfigGroup({
		app: ctx.app,
		panelEl,
		sectionTitle: ctx.t("settings.annotation.section.custom_types"),
		disabled: !ctx.settings.annotationEnabled,
		restoreDefaultsName: ctx.t("settings.annotation.restore_defaults.name"),
		restoreDefaultsDesc: ctx.t("settings.annotation.restore_defaults.desc"),
		restoreDefaultsLabel: ctx.t("settings.common.restore_defaults"),
		restoreDefaultsConfirmText: ctx.t("settings.common.confirm"),
		restoreDefaultsCancelText: ctx.t("settings.common.cancel"),
		labelInputPlaceholder: ctx.t("settings.annotation.type.label_placeholder"),
		colorInputPlaceholder: "#4A86E9",
		items: typeOptions.map((option, index) => ({
			key: option.key,
			name: ctx.t("settings.annotation.type.name") + String(index + 1),
			label: resolveTypeOptionTitle(option, (key) => ctx.t(key)),
			colorHex: option.colorHex,
		})),
		onLabelChange: async (key, label) => {
			const nextTypes = updateCustomTypeSettings(ctx.settings.annotationCustomTypes, key, resolveAnnotationCustomTypes, (item) => {
				item.label = label;
			});
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
		},
		onColorChange: async (key, colorHex) => {
			const previousTypes = resolveAnnotationCustomTypes(ctx.settings.annotationCustomTypes);
			const nextTypes = updateCustomTypeSettings(previousTypes, key, resolveAnnotationCustomTypes, (item) => {
				item.colorHex = colorHex;
			});
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
			await repository.remapTypeColors(ctx.settings, previousTypes, nextTypes);
		},
		onRestoreDefaults: async () => {
			const previousTypes = resolveAnnotationCustomTypes(ctx.settings.annotationCustomTypes);
			const nextTypes = resolveAnnotationCustomTypes(undefined);
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
			await repository.remapTypeColors(ctx.settings, previousTypes, nextTypes);
			refresh();
		},
		isDefaultKey: (key)=>isDefaultTypeKey(key,"annotation"),
		onAddType: async () => {
			const nextTypes = addCustomType(
				ctx.settings.annotationCustomTypes,
				resolveAnnotationCustomTypes
			);
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
			refresh();
		},
		onDeleteType: async (key) => {
			const preTypes = resolveAnnotationCustomTypes(ctx.settings.annotationCustomTypes);
			const nextTypes = deleteCustomType(
				preTypes,
				key,
				resolveAnnotationCustomTypes				
			);
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
			await repository.remapTypeColors(ctx.settings, preTypes, nextTypes);
			refresh();
		},
		addTypeLabel: ctx.t("settings.annotation.add_type"),
		addTypeDesc: ctx.t("settings.annotation.add_type.desc"),
		deleteTypeLabel: ctx.t("settings.annotation.delete_type"),
		deleteTypeConfirmTitle: ctx.t("settings.annotation.delete_type.confirm.title"),
		deleteTypeConfirmMessage: ctx.t("settings.annotation.delete_type.confirm.message"),

	});
}


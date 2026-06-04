import { Setting } from "obsidian";
import { getAnnotationDefaults, resolveAnnotationCustomTypes, resolveAnnotationTypeOptions, resolveTypeOptionTitle, updateCustomTypeSettings,isDefaultTypeKey,addCustomType,deleteCustomType } from "../../../core";
import { getAnnotationRepository } from "../../../features/annotation/repository";
import { createSettingsSectionHeading } from "./heading";
import type { SettingsTabRenderContext } from "./types";
import { renderTypeConfigGroup } from "./custom-config-groups";

export function renderAnnotationSettings(containerEl: HTMLElement, deps: SettingsTabRenderContext): void {
	const { ctx, refresh } = deps;
	const panelEl = containerEl.createDiv({ cls: "cna-settings-panel" });
	const repository = getAnnotationRepository(ctx.app);
	const defaults = getAnnotationDefaults();

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
		isDefaultKey: (key) => isDefaultTypeKey(key, defaults),
		addTypeLabel: ctx.t("settings.annotation.add_type"),
		addTypeDesc: ctx.t("settings.annotation.add_type.desc"),
		deleteTypeLabel: ctx.t("settings.annotation.delete_type"),
		deleteTypeConfirmTitle: ctx.t("settings.annotation.delete_type.confirm.title"),
		deleteTypeConfirmMessage: ctx.t("settings.annotation.delete_type.confirm.message"),
		items: typeOptions.map((option, index) => {
			const isDefault = isDefaultTypeKey(option.key, defaults);
			return{
				key: option.key,
				name: ctx.t("settings.annotation.type.name")+String(index + 1),
				label: isDefault ? resolveTypeOptionTitle(option, (key) => ctx.t(key)) : option.label,
				colorHex: option.colorHex,
			};
		}),
		onLabelChange: async (key, label) => {
			const nextTypes = updateCustomTypeSettings(ctx.settings.annotationCustomTypes, key, resolveAnnotationCustomTypes, (item) => {
				item.label = label;
			});
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
		},
		onAddType: async () => {
			const nextTypes = addCustomType(
				ctx.settings.annotationCustomTypes,
				resolveAnnotationCustomTypes,
				defaults
			);
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
			refresh();
		},
		onDeleteType: async (key) => {
			const previousTypes = resolveAnnotationCustomTypes(ctx.settings.annotationCustomTypes);
			const nextTypes = deleteCustomType(
				ctx.settings.annotationCustomTypes,
				key,
				resolveAnnotationCustomTypes,
				defaults
			);
			await ctx.setSettings({ annotationCustomTypes: nextTypes });
			await repository.remapTypeColors(ctx.settings, previousTypes, nextTypes);
			refresh();
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
	});
}


import { ColorComponent, DropdownComponent, Setting, TextComponent } from "obsidian";
import { DEFAULT_MAP_MARKER_TYPES, MapMarkerType } from "../../../core/custom-type-config";
import { createSettingsSectionHeading } from "./heading";
import type { SettingsTabRenderContext } from "./types";

// ---- 固定配置常量 ----
export const MARKER_SIZE_MIN = 5;
export const MARKER_SIZE_MAX = 20;
export const MARKER_SIZE_STEP = 1;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_STEP = 1;

export const FONT_FAMILY_OPTIONS = [
    "sans-serif",
    "Microsoft YaHei",
    "SimHei",
    "黑体",
    "楷体",
    "宋体",
    "仿宋",
    "华文黑体",
    "华文楷体",
    "华文宋体",
    "华文仿宋",
    "serif",
    "monospace"
];

export function renderMapSettings(containerEl: HTMLElement, deps: SettingsTabRenderContext): void {
    const { ctx, refresh } = deps;
    const panelEl = containerEl.createDiv({ cls: "cna-settings-panel" });
    createSettingsSectionHeading(panelEl, "节点类型默认配置");

    // ---- 表头行（说明各列） ----
    const headerSetting = new Setting(panelEl)
        .setName('类型  ')
        .setClass('cna-settings-item')
    const headerControl = headerSetting.settingEl.querySelector('.setting-item-control') as HTMLElement;
    if (headerControl) {
        headerControl.style.flexWrap = 'wrap';
        headerControl.style.gap = '6px';
        const labels = [
            { text: '名称', width: '80px' },
            { text: '', width: '26px' },
            { text: '点半径', width: '55px' },
            { text: '字号(px)', width: '55px' },
            { text: '字体', width: '130px' }
        ];
        labels.forEach(({ text, width }) => {
            const span = headerControl.createSpan({ text });
            span.style.width = width;
            span.style.fontSize = '13px';
            span.style.textAlign = 'left';
        });
    }

    // 原有的 currentTypes 获取和保存机制...
    const currentTypes: MapMarkerType[] = ctx.settings.markerTypes
        ? ctx.settings.markerTypes.map(t => ({ ...t }))
        : DEFAULT_MAP_MARKER_TYPES.map(t => ({ ...t }));

    let saveTimeout: number | null = null;
    const save = async () => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
        await ctx.setSettings({ markerTypes: currentTypes });
    };
    const debouncedSave = () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = window.setTimeout(save, 300);
    };

    DEFAULT_MAP_MARKER_TYPES.forEach((defaultType, index) => {
        const key = defaultType.key;
        let current = currentTypes.find(t => t.key === key);
        if (!current) {
            current = { ...defaultType };
            currentTypes.push(current);
        }

        const setting = new Setting(panelEl)
            .setName(`类型 ${index + 1}`)
            .setClass("cna-settings-item")

        const controlEl = setting.settingEl.querySelector('.setting-item-control') as HTMLElement;
        if (controlEl) {
            controlEl.style.flexWrap = 'wrap';
            controlEl.style.gap = '6px';
        }

        const updateField = <K extends keyof MapMarkerType>(field: K, value: MapMarkerType[K]) => {
            const target = currentTypes.find(t => t.key === key);
            if (target) {
                target[field] = value;
                debouncedSave();
            }
        };

        // ---- 控件引用（使用非空断言，确保回调后已赋值） ----
        let nameComp!: TextComponent;
        let colorComp!: ColorComponent;
        let sizeComp!: TextComponent;
        let fontSizeComp!: TextComponent;
        // 字体下拉不需要额外引用，但为了统一也声明
        let fontDrop!: DropdownComponent;

        // 1. 名称
        setting.addText(cb => {
            nameComp = cb;
            cb.setValue(current.type)
                .setPlaceholder("显示名");
            cb.inputEl.style.width = '80px';
            cb.onChange(val => updateField('type', val.trim() || defaultType.type));
        });

        // 2. 颜色
        setting.addColorPicker(cb => {
            colorComp = cb;
            cb.setValue(current.color);
            cb.onChange(val => updateField('color', val));
        });

        // 3. 标记大小
        setting.addText(cb => {
            sizeComp = cb;
            cb.setValue(String(current.markerSize))
                .setPlaceholder("大小");
            cb.inputEl.type = 'number';
            cb.inputEl.style.width = '55px';
            cb.inputEl.min = String(MARKER_SIZE_MIN);
            cb.inputEl.max = String(MARKER_SIZE_MAX);
            cb.inputEl.step = String(MARKER_SIZE_STEP);
            cb.onChange(val => {
                let num = parseFloat(val);
                if (isNaN(num)) num = defaultType.markerSize;
                num = Math.min(Math.max(num, MARKER_SIZE_MIN), MARKER_SIZE_MAX);
                updateField('markerSize', num);
                cb.setValue(String(num));
            });
        });

        // 4. 字号
        setting.addText(cb => {
            fontSizeComp = cb;
            cb.setValue(String(current.fontSize))
                .setPlaceholder("字号");
            cb.inputEl.type = 'number';
            cb.inputEl.style.width = '55px';
            cb.inputEl.min = String(FONT_SIZE_MIN);
            cb.inputEl.max = String(FONT_SIZE_MAX);
            cb.inputEl.step = String(FONT_SIZE_STEP);
            cb.onChange(val => {
                let num = parseFloat(val);
                if (isNaN(num)) num = defaultType.fontSize;
                num = Math.min(Math.max(num, FONT_SIZE_MIN), FONT_SIZE_MAX);
                updateField('fontSize', num);
                cb.setValue(String(num));
            });
        });

        // 5. 字体下拉
        setting.addDropdown(cb => {
            fontDrop = cb;
            FONT_FAMILY_OPTIONS.forEach(family => {
                cb.addOption(family, family);
            });
            // 使用 ?? 确保默认值不为 undefined
            cb.setValue(current.fontFamily ?? FONT_FAMILY_OPTIONS[0]);
            cb.selectEl.style.width = '130px';
            cb.onChange(val => updateField('fontFamily', val));
        });

        // ---- 失焦保存（仅对输入控件） ----
        const onBlurSave = () => save();

        nameComp.inputEl.onblur = () => {
            const target = currentTypes.find(t => t.key === key);
            if (target) nameComp.setValue(target.type);
            onBlurSave();
        };
        sizeComp.inputEl.onblur = () => {
            const target = currentTypes.find(t => t.key === key);
            if (target) sizeComp.setValue(String(target.markerSize));
            onBlurSave();
        };
        fontSizeComp.inputEl.onblur = () => {
            const target = currentTypes.find(t => t.key === key);
            if (target) fontSizeComp.setValue(String(target.fontSize));
            onBlurSave();
        };

        // 颜色选择器失焦（安全获取 input 元素）
        const colorInput = (colorComp as any).inputEl || (colorComp as any).colorPickerEl;
        if (colorInput) {
            colorInput.onblur = onBlurSave;
        }

        // 下拉菜单 onChange 已保存，无需额外 onblur
    });

    // ---- 恢复默认按钮 ----
    new Setting(panelEl)
        .setName("恢复默认类型配置")
        .setDesc("重置所有类型为默认名称和颜色")
        .addButton(btn => btn
            .setButtonText("恢复默认")
            .setWarning()
            .onClick(async () => {
                await ctx.setSettings({ markerTypes: undefined });
                refresh();
            })
        );
}
import { AbstractInputSuggest, App, ColorComponent, Modal, Notice, Setting, TextComponent, TFile } from 'obsidian';
import { attachMarkdownSuggest } from '../../ui/componets/file_suggest';
import { MarkerFormData } from './types';
import { PluginContext, SettingDatas } from '../../core';
import { DEFAULT_MAP_MARKER_TYPES, MapMarkerType } from '../../core/custom-type-config';
import { logger } from '../../utils/logger';
import { FONT_FAMILY_OPTIONS, FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SIZE_STEP, MARKER_SIZE_MAX, MARKER_SIZE_MIN, MARKER_SIZE_STEP } from '../setting-tabs/views/map-tab';

export class MarkerModal extends Modal {
    private settings: SettingDatas;
    private result: MarkerFormData | null = null;
    private onSubmit: (result: MarkerFormData | null) => void;
    private linkSuggester: AbstractInputSuggest<TFile> | null = null;
    private rootPath: string = "";
    private previewEl: HTMLElement | null = null;
    private sizeSlider: HTMLInputElement | null = null;
    private sizeDisplay: HTMLElement | null = null;
    private fontSizeSlider: HTMLInputElement | null = null;
    private fontSizeDisplay: HTMLElement | null = null;
    private fontFamilyDropdown: HTMLSelectElement | null = null;

    constructor(
        ctx: PluginContext,
        rootPath: string,
        titleText: string,
        private initialData?: MarkerFormData,
    ) {
        const { app, settings } = ctx;
        super(app);
        this.settings = settings;
        this.setTitle(titleText);
        this.rootPath = rootPath;
    }

    onOpen() {
        this.modalEl.style.width = '450px';
        this.modalEl.style.maxWidth = '100vw';
        const { contentEl } = this;

        // ---------- 数据归一化 ----------
        const raw = this.settings.markerTypes;
        let typesArray: MapMarkerType[] = [];
        if (Array.isArray(raw)) {
            typesArray = raw;
        } else if (raw && typeof raw === 'object') {
            // 旧格式对象，转换为数组并补齐缺失字段
            typesArray = Object.entries(raw).map(([key, val]) => {
                const defaultType = DEFAULT_MAP_MARKER_TYPES.find(t => t.key === key);
                return {
                    key,
                    type: (val as any).label || defaultType?.type || key,
                    color: (val as any).color || defaultType?.color || '#000000',
                    markerSize: (val as any).markerSize ?? defaultType?.markerSize ?? 18,
                    fontSize: (val as any).fontSize ?? defaultType?.fontSize ?? 13,
                    fontFamily: (val as any).fontFamily || defaultType?.fontFamily || 'sans-serif',
                };
            });
        } else {
            // 无数据，使用默认
            typesArray = DEFAULT_MAP_MARKER_TYPES.slice();
        }
        // 建立快速查找映射（按 key 和 type 均可）
        const byKey = new Map(typesArray.map(t => [t.key, t]));
        const byType = new Map(typesArray.map(t => [t.type, t]));

        // ---------- 辅助函数 ----------
        const getFullConfig = (typeValue: string): MapMarkerType => {
            // 先按 type 查找，再按 key 查找
            let found = byType.get(typeValue);
            if (!found) found = byKey.get(typeValue);
            if (found) return { ...found };
            // 兜底：返回第一个类型或硬编码
            return typesArray[0] || {
                key: 'default',
                type: '默认',
                color: '#000000',
                markerSize: 18,
                fontSize: 13,
                fontFamily: 'sans-serif',
            };
        };

        // ---------- UI 控件变量 ----------
        let colorPicker: ColorComponent | null = null;
        let typeTextComp: TextComponent | null = null;
        let currentTypeValue = '';

        // 当前 marker 数据
        let marker: MarkerFormData = {
            label: '',
            link: '',
            key: '',
            type: '',
            color: '',
            markerSize: 0,
            fontSize: 0,
            fontFamily: '',
        };

        // 更新预览
        const updatePreview = () => {
            if (!this.previewEl) return;
            const color = marker.color || '#000000';
            const size = marker.markerSize || 18;
            const fontSize = marker.fontSize || 13;
            const fontFamily = marker.fontFamily || 'sans-serif';
            this.previewEl.style.backgroundColor = color;
            this.previewEl.style.width = size + 'px';
            this.previewEl.style.height = size + 'px';
            this.previewEl.style.fontSize = fontSize + 'px';
            this.previewEl.style.fontFamily = fontFamily;
            // 文本保持 "示例文字"
        };

        // 应用配置到 UI 控件和 marker
        const applyConfig = (config: MapMarkerType) => {
            marker.color = config.color;
            marker.markerSize = config.markerSize;
            marker.fontSize = config.fontSize;
            marker.fontFamily = config.fontFamily;
            // 更新颜色选择器
            if (colorPicker) colorPicker.setValue(config.color);
            // 更新滑块显示
            if (this.sizeSlider) {
                this.sizeSlider.value = String(config.markerSize);
                if (this.sizeDisplay) this.sizeDisplay.textContent = String(config.markerSize);
            }
            if (this.fontSizeSlider) {
                this.fontSizeSlider.value = String(config.fontSize);
                if (this.fontSizeDisplay) this.fontSizeDisplay.textContent = String(config.fontSize);
            }
            if (this.fontFamilyDropdown) {
                // 如果下拉选项中有该字体，则选中，否则选中第一个
                const options = Array.from(this.fontFamilyDropdown.options);
                const match = options.find(opt => opt.value === config.fontFamily);
                if (match) this.fontFamilyDropdown.value = config.fontFamily;
                else if (options.length) this.fontFamilyDropdown.selectedIndex = 0;
            }
            // 同步 marker.type（但类型下拉单独处理）
            updatePreview();
        };

        // ---------- 类型下拉 ----------
        const labelMap: Record<string, string> = {};
        const colorMap: Record<string, string> = {};
        const sizeMap: Record<string, number> = {};
        const fontSizeMap: Record<string, number> = {};
        const fontMap: Record<string, string> = {};
        for (const t of typesArray) {
            labelMap[t.key] = t.type;
            colorMap[t.key] = t.color;
            sizeMap[t.key] = t.markerSize;
            fontSizeMap[t.key] = t.fontSize;
            fontMap[t.key] = t.fontFamily;
        }

        const dropdownOptions: Record<string, string> = {};
        for (const t of typesArray) {
            dropdownOptions[t.key] = t.type;
        }
        // 当前选中的 key
        let selectedKey = '';

        new Setting(contentEl)
            .setName('类型(可选)')
            .setDesc('节点类型')
            .addDropdown(dropdown => {
                dropdown.addOptions(dropdownOptions);
                if (this.initialData) {
                    // 初始数据可能存的是 type，也可能是 key，尝试匹配
                    const initType = this.initialData.type;
                    const matched = typesArray.find(t => t.type === initType || t.key === initType);
                    if (matched) {
                        dropdown.setValue(matched.key);
                        selectedKey = matched.key;
                    } else {
                        // 默认第一个
                        dropdown.setValue(typesArray[0]?.key || '');
                        selectedKey = typesArray[0]?.key || '';
                    }
                } else {
                    // 默认第一个
                    dropdown.setValue(typesArray[0]?.key || '');
                    selectedKey = typesArray[0]?.key || '';
                }
                // 初始化显示自定义输入框（根据是否选中 custom）
                if (selectedKey === 'custom') {
                    if (typeTextComp) typeTextComp.inputEl.style.display = 'inline-flex';
                } else {
                    if (typeTextComp) typeTextComp.inputEl.style.display = 'none';
                }

                dropdown.onChange((value) => {
                    selectedKey = value;
                    // 显示/隐藏自定义输入框
                    if (value === 'custom') {
                        if (typeTextComp) typeTextComp.inputEl.style.display = 'inline-flex';
                    } else {
                        if (typeTextComp) typeTextComp.inputEl.style.display = 'none';
                    }
                    // 获取完整配置
                    const config = getFullConfig(value);
                    // 如果配置存在，应用
                    if (config) {
                        applyConfig(config);
                        // 更新 marker.type 为显示名称（但自定义类型需要特殊处理）
                        if (value === 'custom') {
                            // 自定义时，type 由输入框决定，这里先设为空，由输入框 onChange 更新
                            marker.type = '';
                        } else {
                            marker.type = config.type;
                        }
                        // 更新 marker.key
                        marker.key = config.key;
                        // 如果颜色匹配，已由 applyConfig 设置
                    }
                    // 如果选中自定义，清空 type 并让用户输入
                });
            })
            .addText(text => {
                typeTextComp = text;
                text.setPlaceholder('输入自定义类型名称')
                    .setValue('')
                    .onChange(val => {
                        marker.type = val.trim();
                    });
                text.inputEl.style.display = 'none';
            });

        // ========== 标题 ==========
        new Setting(contentEl)
            .setName('标题')
            .setDesc('节点标题')
            .addText(text => text
                .setValue(this.initialData?.label ?? "")
                .onChange(val => marker.label = val)
            );

        // ========== 链接 ==========
        new Setting(contentEl)
            .setName('链接(可选)')
            .setDesc('关联文件路径（如: 张三）')
            .addText(text => {
                text
                    .setValue(this.initialData?.link ?? '')
                    .onChange(val => marker.link = val);
                this.linkSuggester = attachMarkdownSuggest(this.app, text.inputEl, {
                    shouldIncludeFilePath: (path) => path.startsWith(this.rootPath)
                });
            });



        // ========== 预览区域 ==========
        const previewSetting = new Setting(contentEl)
            .setName('预览')
            .setDesc('当前标记样式');
        // 自定义预览容器
        const previewContainer = previewSetting.controlEl.createDiv({ cls: 'marker-preview-container' });
        this.previewEl = previewContainer.createDiv({
            cls: 'marker-preview-circle',
            text: '示例文字',
        });
        // ========== 颜色 ==========
        new Setting(contentEl)
            .setName('颜色')
            .addColorPicker(picker => {
                colorPicker = picker;
                picker.setValue(this.initialData?.color ?? typesArray[0]?.color ?? '#000000')
                    .onChange(val => {
                        marker.color = val;
                        updatePreview();
                    });
            });
        // ========== 标记大小（滑块） ==========
        new Setting(contentEl)
            .setName('标记大小')
            .setDesc('调整标记圆点尺寸')
            .addText(text => {
                const container = text.inputEl.parentElement;
                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = MARKER_SIZE_MIN.toString();
                slider.max = MARKER_SIZE_MAX.toString();
                slider.step = MARKER_SIZE_STEP.toString();
                slider.value = marker.markerSize.toString();
                this.sizeSlider = slider;
                text.inputEl.style.display = 'none';
                container?.appendChild(slider);
                const display = document.createElement('span');
                display.textContent = marker.markerSize.toString();
                display.style.marginLeft = '8px';
                this.sizeDisplay = display;
                container?.appendChild(display);

                slider.addEventListener('input', () => {
                    const val = parseInt(slider.value, 10);
                    marker.markerSize = val;
                    if (display) display.textContent = String(val);
                    updatePreview();
                });
            });

        // ========== 字号（滑块） ==========
        new Setting(contentEl)
            .setName('字号')
            .setDesc('调整文字大小')
            .addText(text => {
                const container = text.inputEl.parentElement;
                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = FONT_SIZE_MIN.toString();
                slider.max = FONT_SIZE_MAX.toString();
                slider.step = FONT_SIZE_STEP.toString();
                slider.value = marker.fontSize.toString();
                this.fontSizeSlider = slider;
                text.inputEl.style.display = 'none';
                container?.appendChild(slider);
                const display = document.createElement('span');
                display.textContent = marker.fontSize.toString();
                display.style.marginLeft = '8px';
                this.fontSizeDisplay = display;
                container?.appendChild(display);

                slider.addEventListener('input', () => {
                    const val = parseInt(slider.value, 10);
                    marker.fontSize = val;
                    if (display) display.textContent = String(val);
                    updatePreview();
                });
            });

        // ========== 字体族（下拉） ==========
        new Setting(contentEl)
            .setName('字体')
            .setDesc('选择字体')
            .addDropdown(dropdown => {
                // 提供常见字体选项
                for (const f of FONT_FAMILY_OPTIONS) {
                    dropdown.addOption(f, f);
                }
                // 如果 initialData 有值，设置
                if (this.initialData?.fontFamily) {
                    dropdown.setValue(this.initialData.fontFamily);
                }
                this.fontFamilyDropdown = dropdown.selectEl;
                dropdown.onChange(val => {
                    marker.fontFamily = val;
                    updatePreview();
                });
            });

        // ========== 按钮 ==========
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('取消')
                .onClick(() => {
                    this.result = null;
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText('确认')
                .setCta()
                .onClick(() => {
                    this.result = marker;
                    this.close();
                })
            );

        // ---------- 初始化数据到 UI ----------
        if (this.initialData) {
            // 使用 initialData 填充
            marker.label = this.initialData.label || '';
            marker.link = this.initialData.link || '';
            marker.color = this.initialData.color || '';
            marker.markerSize = this.initialData.markerSize || 18;
            marker.fontSize = this.initialData.fontSize || 13;
            marker.fontFamily = this.initialData.fontFamily || 'sans-serif';
            marker.type = this.initialData.type || '';
            marker.key = this.initialData.key || '';
            // 设置颜色选择器
            // if (colorPicker) colorPicker.setValue(marker.color);
            // 设置滑块
            if (this.sizeSlider) {
                this.sizeSlider.value = String(marker.markerSize);
                if (this.sizeDisplay) this.sizeDisplay.textContent = String(marker.markerSize);
            }
            if (this.fontSizeSlider) {
                this.fontSizeSlider.value = String(marker.fontSize);
                if (this.fontSizeDisplay) this.fontSizeDisplay.textContent = String(marker.fontSize);
            }
            if (this.fontFamilyDropdown) {
                // 尝试选中
                const options = Array.from(this.fontFamilyDropdown.options);
                const match = options.find(opt => opt.value === marker.fontFamily);
                if (match) this.fontFamilyDropdown.value = marker.fontFamily;
                else if (options.length) this.fontFamilyDropdown.selectedIndex = 0;
            }
            // 类型下拉：匹配 initialData.type 或 key
            const matched = typesArray.find(t => t.type === marker.type || t.key === marker.key);
            if (matched) {
                // 更新下拉
                const dropdown = contentEl.querySelector('select');
                if (dropdown) {
                    dropdown.value = matched.key;
                    selectedKey = matched.key;
                }
            }
            updatePreview();
        } else {
            // 无初始数据：应用第一个类型的配置
            const first = typesArray[0];
            if (first) {
                applyConfig(first);
                // 同时设置类型下拉为第一个
                const dropdown = contentEl.querySelector('select');
                if (dropdown) {
                    dropdown.value = first.key;
                    selectedKey = first.key;
                }
                marker.type = first.type;
                marker.key = first.key;
                // 颜色已由 applyConfig 设置
            }
        }
    }

    onClose() {
        this.linkSuggester?.close();
        this.linkSuggester = null;
        const { contentEl } = this;
        contentEl.empty();
        if (this.onSubmit) {
            this.onSubmit(this.result);
        }
    }

    waitForResult(): Promise<MarkerFormData | null> {
        return new Promise(resolve => {
            this.onSubmit = resolve;
        });
    }
}
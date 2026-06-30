import { AbstractInputSuggest, App, ColorComponent, Modal, Notice, Setting, TextComponent, TFile } from 'obsidian';
import { attachMarkdownSuggest } from '../../ui/componets/file_suggest';

const LOCATION_TYPES = {
    city: '城市',
    village: '村庄',
    mountain: '山脉',
    forest: '森林',
    lake: '湖泊',
    river: '河流',
    sea: '海域',
    desert: '沙漠',
} as const;

const TYPE_COLORS: Record<string, string> = {
    city: '#3498db',     // 蓝色
    village: '#2ecc71',  // 绿色
    mountain: '#95a5a6', // 灰色
    forest: '#27ae60',   // 深绿
    lake: '#2980b9',     // 深蓝
    river: '#1abc9c',    // 青色
    sea: '#1f618d',      // 深蓝
    desert: '#f1c40f',   // 黄色
    custom: '#95a5a6',
} as const;

export class MarkerModal extends Modal {
    private result: { type: string, label: string; link: string; color: string } | null = null;
    private onSubmit: (result: { label: string; link: string; color: string } | null) => void;
    private linkSuggester: AbstractInputSuggest<TFile> | null = null;
    private rootPath: string = "";
    constructor(
        app: App,
        rootPath: string,
        titleText: string,
        private defaultLabel: string = '',
        private defaultLink: string = '',
        private defaultColor: string = '#e74c3c',
        private defaultType: string = 'city'
    ) {
        super(app);
        this.setTitle(titleText);
        this.rootPath = rootPath;
    }

    onOpen() {
        this.modalEl.style.width = '400px';
        this.modalEl.style.maxWidth = '90vw';
        const { contentEl } = this;
        const customType = Object.keys(LOCATION_TYPES)[0]!;
        const customColor = TYPE_COLORS['custom']!;
        let labelVal = this.defaultLabel;
        let linkVal = this.defaultLink;
        let colorVal = this.defaultColor;
        let typeVal = this.defaultType;
        let colorPicker: ColorComponent | null = null;
        // ========== 类型设置 ==========
        // 保存文本输入框组件引用，以便控制显隐
        let typeTextComp: TextComponent | null = null;

        new Setting(contentEl)
            .setName('类型(可选)')
            .setDesc('节点类型')
            .addDropdown(dropdown => {
                dropdown
                    .addOptions(LOCATION_TYPES)
                    .addOption('__custom__', '✏️ 自定义')
                    .setValue(customType);

                dropdown.onChange((value) => {
                    // 处理自定义输入框的显隐
                    if (value === '__custom__') {
                        if (typeTextComp) {
                            typeTextComp.inputEl.style.display = 'inline-flex';
                        }
                        colorVal = customColor;
                        colorPicker?.setValue(customColor);
                    } else {
                        if (typeTextComp) {
                            typeTextComp.inputEl.style.display = 'none';
                        }
                        const matchedColor = TYPE_COLORS[value];
                        if (matchedColor) {
                            colorVal = matchedColor;
                            if (colorPicker) {
                                colorPicker.setValue(matchedColor);
                            }
                        }
                    }
                });
            })
            .addText(text => {
                typeTextComp = text;
                text.setPlaceholder('输入自定义类型名称')
                    .setValue('')
                    .onChange(val => typeVal = val);
                text.inputEl.style.display = 'none';
            });

        // ========== 标题 ==========
        new Setting(contentEl)
            .setName('标题')
            .setDesc('节点标题')
            .addText(text => text
                .setValue(labelVal)
                .onChange(val => labelVal = val)
            );

        // ========== 链接 ==========
        new Setting(contentEl)
            .setName('链接(可选)')
            .setDesc('关联文件路径（如: 张三）')
            .addText(text => {
                text
                    .setValue(linkVal)
                    .onChange(val => linkVal = val);
                this.linkSuggester = attachMarkdownSuggest(this.app, text.inputEl, {
                    shouldIncludeFilePath: (path) => path.startsWith(this.rootPath)
                })
            });

        // ========== 颜色 ==========
        new Setting(contentEl)
            .setName('颜色')
            .addColorPicker(picker => {
                colorPicker = picker;
                picker.setValue(colorVal)
                    .onChange(val => colorVal = val);
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
                    if (!labelVal.trim()) {
                        new Notice('标题不能为空');
                        return;
                    }
                    this.result = {
                        type: typeVal.trim(),
                        label: labelVal.trim(),
                        link: linkVal.trim(),
                        color: colorVal
                    };
                    this.close();
                })
            );
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

    /** 等待用户提交结果 */
    waitForResult(): Promise<{ label: string; link: string; color: string } | null> {
        return new Promise(resolve => {
            this.onSubmit = resolve;
        });
    }
}
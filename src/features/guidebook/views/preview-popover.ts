import { Component, type App, MarkdownRenderer, setIcon } from "obsidian";
import type { GuidebookKeywordPreviewItem } from "../../../features/text-detection/rules/guidebook-keyword";
import { UI } from "../../../core";
import type { TranslationKey } from "../../../lang";
import { clamp } from "../../../utils";
import { collectGuidebookAliases } from "../alias-utils";

/**
 * 预览弹窗的显示配置选项
 */
export interface GuidebookPreviewDisplayOptions {
	width: number;          // 弹窗宽度（像素）
	maxLines: number;       // 内容最大显示行数（超出滚动）
	enableWesternNameAutoAlias: boolean; // 是否启用西文人名自动别名
}

/**
 * 预览弹窗中的可执行操作回调
 */
export interface GuidebookPreviewPopoverActions {
	onLocate?: (item: GuidebookKeywordPreviewItem) => void; // 定位到源文件中的词条位置
	onOpen?: (item: GuidebookKeywordPreviewItem) => void;   // 打开源文件
}

/**
 * 渲染 Markdown 所需的上下文（用于 MarkdownRenderer）
 */
export interface GuidebookPreviewPopoverRenderContext {
	app: App;
	component: Component;
}

/**
 * 国际化接口
 */
export interface GuidebookPreviewPopoverI18n {
	t: (key: TranslationKey) => string;
}

const PREVIEW_MIN_WIDTH = 200;   // 弹窗最小宽度
const PREVIEW_MAX_WIDTH = 800;   // 弹窗最大宽度
const PREVIEW_MIN_LINES = 1;     // 内容最小行数
const PREVIEW_MAX_LINES = 30;    // 内容最大行数

/**
 * 指南手册关键词预览弹窗类
 * 负责创建一个浮动弹窗，展示关键词的详细信息（标题、分类、别名、正文等）
 */
export class GuidebookPreviewPopover {
	private readonly rootEl: HTMLElement;                // 弹窗根元素
	private readonly headerMainEl: HTMLElement;
	private readonly titleEl: HTMLElement;              // 词条名称
	private readonly metaEl: HTMLElement;               // 元信息（来源文件 / 分类）
	private readonly aliasSectionEl: HTMLElement;       // 别名区域容器
	private readonly aliasLabelEl: HTMLElement;         // “别名”标签
	private readonly aliasValueEl: HTMLElement;         // 别名列表
	private readonly contentEl: HTMLElement;            // 正文区域（支持 Markdown 渲染）
	private readonly emptyEl: HTMLElement;              // 无内容时显示的占位元素
	private readonly locateButtonEl: HTMLButtonElement; // “定位”按钮
	private readonly openButtonEl: HTMLButtonElement;   // “打开”按钮

	private readonly actions: GuidebookPreviewPopoverActions;
	private readonly renderContext?: GuidebookPreviewPopoverRenderContext;
	private readonly t: (key: TranslationKey) => string;

	private currentPreviewItem: GuidebookKeywordPreviewItem | null = null;
	private currentDisplayOptions: Pick<GuidebookPreviewDisplayOptions, "maxLines"> | null = null;
	private visible = false;
	private contentRenderVersion = 0; // 用于取消过时的异步渲染任务

	constructor(
		hostEl?: HTMLElement,
		actions?: GuidebookPreviewPopoverActions,
		renderContext?: GuidebookPreviewPopoverRenderContext,
		i18n?: GuidebookPreviewPopoverI18n,
	) {
		this.actions = actions ?? {};
		this.renderContext = renderContext;
		this.t = i18n?.t ?? ((key) => key);

		// 创建弹窗 DOM 结构
		this.rootEl = (hostEl ?? document.body).createDiv({ cls: "cna-guidebook-preview-popover" });
		this.rootEl.hide();

		// 头部区域
		const headerEl = this.rootEl.createDiv({ cls: "cna-guidebook-preview-popover__header" });
		this.headerMainEl = headerEl.createDiv({ cls: "cna-guidebook-preview-popover__header-main" });
		this.titleEl = this.headerMainEl.createDiv({ cls: "cna-guidebook-preview-popover__title" });
		this.metaEl = this.headerMainEl.createDiv({ cls: "cna-guidebook-preview-popover__meta" });

		// 操作按钮组
		const actionGroupEl = headerEl.createDiv({ cls: "cna-guidebook-preview-popover__actions" });
		this.locateButtonEl = actionGroupEl.createEl("button", {
			cls: "cna-guidebook-preview-popover__action-button",
			attr: { type: "button", "aria-label": this.t("feature.guidebook.preview.action.locate") },
		});
		setIcon(this.locateButtonEl, UI.ICON.SEARCH);
		this.openButtonEl = actionGroupEl.createEl("button", {
			cls: "cna-guidebook-preview-popover__action-button",
			attr: { type: "button", "aria-label": this.t("feature.guidebook.preview.action.open") },
		});
		setIcon(this.openButtonEl, UI.ICON.PENCIL);

		// 别名区域
		this.aliasSectionEl = this.rootEl.createDiv({ cls: "cna-guidebook-preview-popover__aliases" });
		this.aliasLabelEl = this.aliasSectionEl.createDiv({
			cls: "cna-guidebook-preview-popover__alias-label",
			text: this.t("feature.guidebook.preview.alias_label"),
		});
		this.aliasValueEl = this.aliasSectionEl.createDiv({ cls: "cna-guidebook-preview-popover__alias-value" });

		// 正文区域
		this.contentEl = this.rootEl.createDiv({ cls: "cna-guidebook-preview-popover__content" });
		this.contentEl.addClass("markdown-rendered");
		this.emptyEl = this.rootEl.createDiv({
			cls: "cna-guidebook-preview-popover__empty",
			text: this.t("feature.guidebook.preview.empty_content"),
		});

		// 绑定按钮事件
		this.locateButtonEl.addEventListener("click", () => {
			if (!this.currentPreviewItem) return;
			this.actions.onLocate?.(this.currentPreviewItem);
		});
		this.openButtonEl.addEventListener("click", () => {
			if (!this.currentPreviewItem) return;
			this.actions.onOpen?.(this.currentPreviewItem);
		});
	}

	/**
	 * 显示预览弹窗
	 * @param previewItem 要预览的词条数据
	 * @param anchorRect 锚点元素（例如高亮的关键词）的屏幕位置
	 * @param options 显示配置（宽度、最大行数、别名开关）
	 */
	show(
		previewItem: GuidebookKeywordPreviewItem,
		anchorRect: DOMRect,
		options: GuidebookPreviewDisplayOptions,
	): void {
		const width = clamp(options.width, PREVIEW_MIN_WIDTH, PREVIEW_MAX_WIDTH);
		const maxLines = clamp(options.maxLines, PREVIEW_MIN_LINES, PREVIEW_MAX_LINES);
		this.currentPreviewItem = previewItem;
		this.currentDisplayOptions = { maxLines };

		// 解析内容中的特殊语法（如【状态】）并收集别名（通过 collectGuidebookAliases）
		const parsed = parseAliasesAndContent(
			typeof previewItem.content === "string" ? previewItem.content : "",
			previewItem.title,
			options.enableWesternNameAutoAlias,
		);

		// 更新 UI
		this.titleEl.setText(formatPreviewTitle(previewItem.title, parsed.status));
		this.metaEl.setText(this.resolveMetaText(previewItem));

		// 显示或隐藏别名区域
		if (parsed.aliases.length > 0) {
			this.aliasValueEl.setText(parsed.aliases.join(" "));
			this.aliasSectionEl.toggleClass("is-visible", true);
		} else {
			this.aliasValueEl.empty();
			this.aliasSectionEl.toggleClass("is-visible", false);
		}

		// 异步渲染正文 Markdown，使用版本号避免旧渲染结果覆盖新内容
		const renderVersion = ++this.contentRenderVersion;
		void this.renderPreviewContent(parsed.content, previewItem.sourcePath, renderVersion);
		this.contentEl.toggleClass("is-empty", parsed.content.length === 0);
		this.emptyEl.toggleClass("is-visible", parsed.content.length === 0);

		// 设置宽度并应用高度限制
		this.rootEl.style.width = `${width}px`;
		this.rootEl.show();
		this.rootEl.toggleClass("is-positioning", true);
		this.applyContentHeightLimit();

		// 定位弹窗
		const bounds = this.rootEl.getBoundingClientRect();
		const position = this.resolvePosition(anchorRect, bounds);
		this.rootEl.setCssProps({ left: `${position.left}px`, top: `${position.top}px` });
		this.rootEl.toggleClass("is-positioning", false);
		this.rootEl.toggleClass("is-visible", true);
		this.visible = true;
	}

	/**
	 * 隐藏弹窗
	 */
	hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.currentPreviewItem = null;
		this.currentDisplayOptions = null;
		this.contentRenderVersion += 1; // 使正在进行的渲染失效
		this.rootEl.toggleClass("is-visible", false);
		this.rootEl.hide();
	}

	/**
	 * 判断给定的目标节点是否在弹窗内部（用于点击外部关闭判断）
	 */
	containsTarget(target: EventTarget | null): boolean {
		return target instanceof Node && this.rootEl.contains(target);
	}

	getElement(): HTMLElement {
		return this.rootEl;
	}

	destroy(): void {
		this.hide();
		this.rootEl.remove();
	}

	/**
	 * 生成元信息文本：源文件名 / 分类标题
	 */
	private resolveMetaText(previewItem: GuidebookKeywordPreviewItem): string {
		const sourceName = (previewItem.sourcePath.split("/").pop() ?? previewItem.sourcePath).replace(/\.md$/i, "");
		if (previewItem.categoryTitle.trim().length === 0) {
			return sourceName;
		}
		return `${sourceName} / ${previewItem.categoryTitle}`;
	}

	/**
	 * 渲染正文（支持 Markdown）
	 * @param content 原始文本
	 * @param sourcePath 源文件路径，用于相对路径解析
	 * @param renderVersion 当前渲染版本号，用于避免过时渲染覆盖新内容
	 */
	private async renderPreviewContent(
		content: string,
		sourcePath: string,
		renderVersion: number,
	): Promise<void> {
		this.contentEl.empty();
		if (content.length === 0) return;

		// 如果没有提供 Markdown 渲染上下文，只显示纯文本
		if (!this.renderContext) {
			this.contentEl.setText(content);
			return;
		}

		try {
			await MarkdownRenderer.render(
				this.renderContext.app,
				content,
				this.contentEl,
				sourcePath,
				this.renderContext.component,
			);
			if (renderVersion !== this.contentRenderVersion) {
				this.contentEl.empty(); // 被新渲染请求取消
				return;
			}
			this.applyContentHeightLimit();
		} catch (error) {
			console.error(error);
			if (renderVersion === this.contentRenderVersion) {
				this.contentEl.empty();
				this.contentEl.setText(content);
				this.applyContentHeightLimit();
			}
		}
	}

	/**
	 * 根据配置的最大行数限制内容区域的高度
	 */
	private applyContentHeightLimit(): void {
		const options = this.currentDisplayOptions;
		if (!options) return;
		const lineHeightPx = this.resolveContentLineHeightPx();
		const maxByLines = Math.max(24, Math.round(options.maxLines * lineHeightPx));
		this.contentEl.setCssProps({ "max-height": `${maxByLines}px` });
	}

	/**
	 * 计算内容区域的行高（像素），用于行数限制
	 */
	private resolveContentLineHeightPx(): number {
		const computedStyle = window.getComputedStyle(this.contentEl);
		const lineHeight = Number.parseFloat(computedStyle.lineHeight);
		if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
		const fontSize = Number.parseFloat(computedStyle.fontSize);
		const safeFontSize = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
		return safeFontSize * 1.65; // 默认行高为字体的1.65倍
	}

	/**
	 * 计算弹窗在屏幕上的最佳位置（尽量在锚点右侧，空间不足时左侧，上下边界自适应）
	 */
	private resolvePosition(anchorRect: DOMRect, popoverBounds: DOMRect): { left: number; top: number } {
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const gap = 10;
		const edgePadding = 8;

		// 水平方向：默认右侧，若超出则左侧
		let left = anchorRect.right + gap;
		if (left + popoverBounds.width > viewportWidth - edgePadding) {
			left = anchorRect.left - popoverBounds.width - gap;
		}
		left = clamp(left, edgePadding, Math.max(edgePadding, viewportWidth - popoverBounds.width - edgePadding));

		// 垂直方向：默认与锚点顶部对齐，若下方空间不足则向上偏移
		let top = anchorRect.top;
		if (top + popoverBounds.height > viewportHeight - edgePadding) {
			top = anchorRect.bottom - popoverBounds.height;
		}
		top = clamp(top, edgePadding, Math.max(edgePadding, viewportHeight - popoverBounds.height - edgePadding));

		return { left, top };
	}
}

/**
 * 解析词条内容中的特殊标记（【状态】、【别名】），提取状态、过滤别名字段并标准化正文
 * @param content 原始 Markdown 内容
 * @param keyword 关键词本身
 * @param enableWesternNameAutoAlias 是否启用西文人名自动别名
 * @returns 别名数组、处理后的正文内容、状态（死亡/失效/null）
 */
function parseAliasesAndContent(
	content: string,
	keyword: string,
	enableWesternNameAutoAlias: boolean,
): { aliases: string[]; content: string; status: "死亡" | "失效" | null } {
	const lines = content.split(/\r?\n/);
	const keptLines: string[] = [];
	let status: "死亡" | "失效" | null = null;

	for (const line of lines) {
		// 提取【状态】行，状态仅取首次出现
		const statusMatch = line.match(/【状态】\s*[:：]?\s*(死亡|失效)/);
		if (statusMatch && statusMatch[1] && !status) {
			status = statusMatch[1] as "死亡" | "失效";
		}
		if (statusMatch) continue; // 跳过状态行，不放入正文

		// 提取【别名】行（仅用于解析，不保留到正文）
		const aliasMatch = line.match(/【别名】\s*[:：]?\s*(.+)$/);
		if (aliasMatch) continue; // 跳过别名字段行

		keptLines.push(line);
	}

	// 规范化列表边界：在列表项后若紧跟非列表项且非空行，则插入空行避免渲染粘连
	const normalizedLines = normalizeListBoundaryLines(keptLines);
	const normalizedContent = normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

	// 利用现有的别名生成工具获取该词条的所有别名（与预览无关，仅用于显示，但这里直接调用了工具）
	// 注意：该函数内部也会读取【别名】行，但我们已经提前移除了这些行，所以传原始 content 是正确的。
	return {
		aliases: collectGuidebookAliases({
			keyword,
			content,
			enableWesternNameAutoAlias,
		}),
		content: normalizedContent,
		status,
	};
}

/**
 * 在列表项（- / * / 数字.）和非列表项之间插入必要的空行，保证 Markdown 渲染正确
 */
function normalizeListBoundaryLines(lines: string[]): string[] {
	const normalized: string[] = [];
	for (const line of lines) {
		const previousLine = normalized[normalized.length - 1] ?? "";
		const previousTrimmed = previousLine.trim();
		const currentTrimmed = line.trim();
		const previousIsListItem = isMarkdownListItemLine(previousTrimmed);
		const currentIsBlank = currentTrimmed.length === 0;
		const currentIsListItem = isMarkdownListItemLine(currentTrimmed);
		const currentIsIndented = /^[ \t]/.test(line);

		// 如果上一行是列表项，当前行不是空行也不是列表项且没有缩进，则插入一个空行
		if (previousIsListItem && !currentIsBlank && !currentIsListItem && !currentIsIndented) {
			normalized.push("");
		}
		normalized.push(line);
	}
	return normalized;
}

/**
 * 判断一行文本是否为 Markdown 列表项（无序或有序）
 */
function isMarkdownListItemLine(line: string): boolean {
	return /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line);
}

/**
 * 格式化标题：若存在状态（死亡/失效），追加到标题后
 */
function formatPreviewTitle(baseTitle: string, status: "死亡" | "失效" | null): string {
	if (!status) return baseTitle;
	return `${baseTitle}【${status}】`;
}
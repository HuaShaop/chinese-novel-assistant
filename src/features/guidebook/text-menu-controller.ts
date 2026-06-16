import type { EditorView } from "@codemirror/view";
import { Editor, MarkdownFileInfo, MarkdownView, Menu, MenuItem, setIcon, type Plugin } from "obsidian";
import { UI, type SettingDatas } from "../../core";
import type { TranslationKey } from "../../lang";
import { resolveEditorViewFromMarkdownView } from "../../utils";
import { appendGuidebookSettingToCategoryByPath } from "./menu-actions";
import { buildGuidebookTreeData, type GuidebookTreeData } from "./tree-builder";
import { SPECIFIC_SETTING_VALUES, type SpecificSettingValue } from "./guidebook-constants";
import { logger } from "../../utils/logger";

/**
 * 文本菜单控制器配置选项
 */
interface TextMenuControllerOptions {
	getSettings: () => SettingDatas;                                   // 获取插件设置
	t: (key: TranslationKey) => string;                               // 国际化翻译函数
	isGuidebookKeywordInEditor: (editorView: EditorView, keyword: string) => boolean; // 判断选中文本是否已是指南关键词
}

/**
 * 顶级菜单项对应的数据结构：一个文件包含多个分类（H1）
 */
interface AddSettingCollectionItem {
	title: string;                    // 文件名（不带扩展名）
	categories: AddSettingCategoryItem[]; // 该文件下的所有分类
}

/**
 * 二级菜单项对应的数据结构：一个具体分类（H1）
 */
interface AddSettingCategoryItem {
	title: string;          // H1 标题
	sourcePath: string;     // 所属文件的路径
	h1IndexInSource: number; // 该 H1 在文件中的索引（第几个 H1）
}

/**
 * 扩展 MenuItem 类型，用于检测是否有 submenu 属性（Obsidian 内部接口）
 */
interface MenuItemWithSubmenu {
	setSubmenu?: (...args: unknown[]) => unknown;
	submenu?: Menu;
}

const MENU_REFRESH_DELAY = 120; // 刷新树数据的防抖延迟（ms）

/**
 * 文本菜单指南手册控制器
 * 负责在编辑器的右键菜单中动态添加“添加到指南手册”功能，允许用户将选中的文本作为新词条添加到已有的指南手册分类中。
 * 核心功能：
 * - 监听 editor-menu 事件，构建多级菜单。
 * - 根据当前活跃文件所在文库，动态加载可用的指南手册文件及其 H1 分类。
 * - 当鼠标悬停或点击菜单项时，显示二级面板（分类列表），支持进一步选择具体 H2 位置。
 * - 处理面板的定位、层级（z-index）、延迟隐藏等交互细节。
 * - 添加完成后刷新缓存并关闭所有菜单。
 */
export class TextMenuGuidebookController {
	private readonly plugin: Plugin;
	private readonly getSettings: () => SettingDatas;
	private readonly t: (key: TranslationKey) => string;
	private readonly isGuidebookKeywordInEditor: (editorView: EditorView, keyword: string) => boolean;

	private cachedTreeData: GuidebookTreeData | null = null; // 缓存的指南手册树结构
	private categoryPanelEl: HTMLElement | null = null;      // 二级分类面板元素
	private categoryPanelContentKey: string | null = null;   // 用于判断面板内容是否变化的 key
	private categoryPanelZIndex: number | null = null;       // 动态计算的面板层级
	private activeEditorContextMenu: Menu | null = null;     // 当前打开的编辑器右键菜单
	private activeAddSettingLevel1Menu: Menu | null = null;  // 当前打开的“添加设定”一级子菜单
	private refreshTimer: number | null = null;              // 刷新树数据的定时器
	private categoryPanelHideTimer: number | null = null;    // 隐藏面板的延迟定时器
	private refreshToken = 0;                                 // 用于取消过期的异步刷新请求
	private started = false;

	constructor(
		plugin: Plugin,
		options: TextMenuControllerOptions,
	) {
		this.plugin = plugin;
		this.getSettings = options.getSettings;
		this.t = options.t;
		this.isGuidebookKeywordInEditor = options.isGuidebookKeywordInEditor;
	}

	/**
	 * 启动控制器：注册事件监听，初始化树数据
	 */
	start(): void {
		if (this.started) return;
		this.started = true;

		// 监听编辑器右键菜单事件
		this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", this.onEditorMenu));

		// 文件打开时刷新树数据
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("file-open", (file) => {
				this.scheduleTreeRefresh(file?.path ?? null);
			}),
		);

		// 活动叶子变化时刷新（切换标签页）
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView) {
					this.scheduleTreeRefresh(view.file?.path ?? null);
				}
			}),
		);

		// 全局鼠标点击：用于关闭面板（点击面板外部时隐藏）
		this.plugin.registerDomEvent(document, "mousedown", this.onDocumentMouseDown);

		// 初始刷新
		this.scheduleTreeRefresh(this.resolveActiveFilePath());
	}

	/**
	 * 设置变更时重新刷新树数据
	 */
	handleSettingsChange(): void {
		this.scheduleTreeRefresh(this.resolveActiveFilePath());
	}

	/**
	 * 仓库文件变更时（例如指南手册文件被修改）刷新树数据
	 */
	handleVaultChange(): void {
		this.scheduleTreeRefresh(this.resolveActiveFilePath());
	}

	/**
	 * 销毁控制器：清理定时器和 DOM 元素
	 */
	dispose(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearCategoryPanelHideTimer();
		if (this.categoryPanelEl) {
			this.categoryPanelEl.remove();
			this.categoryPanelEl = null;
		}
	}

	// ==================== 私有事件处理 ====================

	/**
	 * 编辑器右键菜单事件处理器
	 * 向菜单中添加“添加到指南手册”项，并根据选中的文本和可用的指南手册数据构建子菜单。
	 */
	private readonly onEditorMenu = (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo): void => {
		this.activeEditorContextMenu = menu;
		const selectedText = normalizeSelection(editor.getSelection() ?? "");
		if (selectedText.length === 0) return;

		// 获取当前的 EditorView，用于判断选中文本是否已经是关键词（避免重复添加）
		const markdownView = info instanceof MarkdownView ? info : null;
		const editorView = markdownView ? resolveEditorViewFromMarkdownView(markdownView) : null;
		if (editorView && this.isGuidebookKeywordInEditor(editorView, selectedText)) {
			// 如果选中的文本已经是某个已有的关键词，则不再显示“添加”菜单（避免重复）
			return;
		}

		const collectionItems = this.buildAddSettingCollectionItems();
		menu.onHide(() => {
			if (this.activeEditorContextMenu === menu) this.activeEditorContextMenu = null;
			this.activeAddSettingLevel1Menu = null;
			this.categoryPanelZIndex = null;
			this.categoryPanelContentKey = null;
			this.hideCategoryPanelImmediate();
		});

		menu.addItem((item) => {
			item
				.setTitle(this.t("feature.editor_menu.add_setting"))
				.setIcon(UI.ICON.ADD_TO_GUIDEBOOK);

			if (collectionItems.length === 0) {
				item.setDisabled(true);
				return;
			}

			// 尝试使用 Obsidian 原生子菜单 API（如果可用）
			if (this.attachSubmenuByBuilder(item,
				(submenu) => { this.fillCollectionSubmenu(submenu, collectionItems, selectedText); },
				(submenu) => { this.activeAddSettingLevel1Menu = submenu; })
			) {
				// logger.debug("使用 Obsidian 原生子菜单 API");
				return;
			}
			// logger.debug("降级方案：手动创建子菜单并绑定 click 事件");
			// 降级方案：手动创建子菜单并绑定 click 事件
			const collectionSubmenu = this.createCollectionSubmenu(collectionItems, selectedText);
			this.activeAddSettingLevel1Menu = collectionSubmenu;
			item.onClick((evt) => {
				if (evt instanceof MouseEvent) {
					collectionSubmenu.showAtMouseEvent(evt);
				}
			});
		});
	};

	// ==================== 菜单构建辅助方法 ====================

	/**
	 * 从缓存的树数据中构建“添加设定”的一级菜单项数据（文件列表）
	 */
	private buildAddSettingCollectionItems(): AddSettingCollectionItem[] {
		const treeData = this.cachedTreeData;
		if (!treeData) return [];

		const collections: AddSettingCollectionItem[] = [];
		for (const fileNode of treeData.files) {
			const categories: AddSettingCategoryItem[] = [];
			for (const h1Node of fileNode.h1List) {
				const title = h1Node.title.trim();
				if (title.length === 0) continue;
				categories.push({
					title,
					sourcePath: h1Node.sourcePath,
					h1IndexInSource: h1Node.h1IndexInSource,
				});
			}
			if (categories.length === 0) continue;
			collections.push({
				title: fileNode.fileName,
				categories,
			});
		}
		return collections;
	}

	/**
	 * 创建一级子菜单（文件列表）
	 */
	private createCollectionSubmenu(
		collectionItems: AddSettingCollectionItem[],
		selectedText: string,
	): Menu {
		const submenu = new Menu();
		for (const collectionItem of collectionItems) {
			const isSpecial = SPECIFIC_SETTING_VALUES.includes(collectionItem.title as SpecificSettingValue);
			submenu.addItem((item) => {
				item.setTitle(collectionItem.title)
					.setIcon(isSpecial ? UI.ICON.FOLDER : UI.ICON.FILE);
				this.bindCollectionItemInteractions(item, collectionItem.categories, selectedText, isSpecial);
			});
		}
		return submenu;
	}

	/**
	 * 填充已有的子菜单（使用原生 API 时）
	 */
	private fillCollectionSubmenu(
		submenu: Menu,
		collectionItems: AddSettingCollectionItem[],
		selectedText: string,
	): void {
		for (const collectionItem of collectionItems) {
			const isSpecial = SPECIFIC_SETTING_VALUES.includes(collectionItem.title as SpecificSettingValue)
			submenu.addItem((item) => {
				item.setTitle(collectionItem.title)
					.setIcon(isSpecial ? UI.ICON.FOLDER : UI.ICON.FILE);
				this.bindCollectionItemInteractions(item, collectionItem.categories, selectedText, isSpecial);
			});
		}
	}

	/**
	 * 尝试使用 Obsidian 的 setSubmenu API（原生子菜单）
	 */
	private attachSubmenu(item: MenuItem, submenu: Menu): boolean {
		const menuItemAny = item as unknown as MenuItemWithSubmenu;
		if (typeof menuItemAny.setSubmenu !== "function") return false;
		try {
			menuItemAny.setSubmenu(submenu);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 使用 builder 模式附加子菜单，兼容新旧 Obsidian 版本
	 */
	private attachSubmenuByBuilder(
		item: MenuItem,
		builder: (submenu: Menu) => void,
		onResolvedSubmenu?: (submenu: Menu) => void,
	): boolean {
		const menuItemAny = item as unknown as MenuItemWithSubmenu;
		if (typeof menuItemAny.setSubmenu !== "function") return false;
		try {
			menuItemAny.setSubmenu();
			if (menuItemAny.submenu) {
				builder(menuItemAny.submenu);
				onResolvedSubmenu?.(menuItemAny.submenu);
				return true;
			}
		} catch {
			// 降级
		}
		const legacySubmenu = new Menu();
		builder(legacySubmenu);
		onResolvedSubmenu?.(legacySubmenu);
		return this.attachSubmenu(item, legacySubmenu);
	}

	/**
	 * 为每个菜单项绑定交互：鼠标悬停/离开时显示二级分类面板，点击时直接显示面板
	 */
	private bindCollectionItemInteractions(
		item: MenuItem,
		categories: AddSettingCategoryItem[],
		selectedText: string,
		isSpecial: boolean
	): void {
		const menuItemAny = item as unknown as { dom?: HTMLElement; domEl?: HTMLElement };
		// 延迟获取 DOM 元素，等待菜单渲染完成
		window.setTimeout(() => {
			const menuItemEl = this.resolveMenuItemContainerEl(menuItemAny.domEl ?? menuItemAny.dom);
			if (!(menuItemEl instanceof HTMLElement)) return;

			menuItemEl.classList.add("cna-text-menu-has-children");
			const panelContentKey = this.buildCategoryPanelKey(categories, selectedText);

			const showPanel = (): void => {
				this.showCategoryPanel(menuItemEl, categories, selectedText, panelContentKey, isSpecial);
			};

			menuItemEl.addEventListener("mouseenter", showPanel);
			menuItemEl.addEventListener("mouseleave", () => {
				this.scheduleHideCategoryPanel();
			});
			menuItemEl.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				showPanel();
			});
		}, 0);
	}

	// ==================== 二级面板（分类面板）管理 ====================

	/**
	 * 全局鼠标点击事件：若点击位置不在面板内，则立即隐藏面板
	 */
	private readonly onDocumentMouseDown = (event: MouseEvent): void => {
		const target = event.target;
		if (target instanceof Node && this.categoryPanelEl?.contains(target)) return;
		this.hideCategoryPanelImmediate();
	};

	/**
	 * 显示分类面板
	 * @param anchorEl 触发面板的菜单项 DOM 元素（作为定位锚点）
	 * @param categories 分类列表
	 * @param selectedText 用户选中的文本（用于添加到指南手册）
	 * @param panelContentKey 面板内容标识（用于判断是否需要重新渲染）
	 */
	private showCategoryPanel(
		anchorEl: HTMLElement,
		categories: AddSettingCategoryItem[],
		selectedText: string,
		panelContentKey: string,
		isSpecial: boolean
	): void {
		const panelEl = this.ensureCategoryPanelEl();
		this.clearCategoryPanelHideTimer();

		// 如果内容已变化，重新渲染；否则仅清除高亮状态
		if (panelContentKey !== this.categoryPanelContentKey || panelEl.childElementCount === 0) {
			panelEl.empty();
			this.renderCategoryPanelItems(panelEl, categories, selectedText, isSpecial);
			this.categoryPanelContentKey = panelContentKey;
		} else {
			this.clearCategoryPanelActiveState(panelEl);
		}

		this.elevateCategoryPanelAboveMenus(panelEl);

		// 定位面板
		panelEl.toggleClass("is-positioning", true);
		panelEl.show();
		const anchorRect = anchorEl.getBoundingClientRect();
		const panelRect = panelEl.getBoundingClientRect();
		const gap = 6;
		let left = anchorRect.right + gap;
		if (left + panelRect.width > window.innerWidth - 8) {
			left = anchorRect.left - panelRect.width - gap;
		}
		left = Math.max(8, Math.min(left, window.innerWidth - panelRect.width - 8));
		let top = anchorRect.top;
		if (top + panelRect.height > window.innerHeight - 8) {
			top = window.innerHeight - panelRect.height - 8;
		}
		top = Math.max(8, top);
		panelEl.setCssProps({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
		});
		panelEl.toggleClass("is-positioning", false);
	}

	/**
	 * 渲染分类面板内的每一项
	 */
	private renderCategoryPanelItems(
		panelEl: HTMLElement,
		categories: AddSettingCategoryItem[],
		selectedText: string,
		isSpecial: boolean
	): void {
		for (const category of categories) {
			const itemEl = panelEl.createDiv({ cls: "menu-item" });
			const iconEl = itemEl.createDiv({ cls: "menu-item-icon" });
			setIcon(iconEl, isSpecial ? UI.ICON.FILE : UI.ICON.H2);
			itemEl.createDiv({ cls: "menu-item-title", text: category.title });

			itemEl.addEventListener("mouseenter", () => {
				this.setCategoryPanelActiveItem(itemEl);
			});
			itemEl.addEventListener("mousedown", (event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				this.setCategoryPanelActiveItem(itemEl);
				void this.appendSettingToCategory(category, selectedText, isSpecial);
				this.hideCategoryPanelImmediate();
			});
		}
	}

	/**
	 * 确保分类面板 DOM 元素存在，并设置鼠标移入/移出延迟隐藏逻辑
	 */
	private ensureCategoryPanelEl(): HTMLElement {
		if (this.categoryPanelEl && this.categoryPanelEl.isConnected) {
			return this.categoryPanelEl;
		}
		const panelEl = document.body.createDiv({ cls: "menu cna-text-menu-category-panel" });
		panelEl.hide();
		panelEl.addEventListener("mouseenter", () => {
			this.clearCategoryPanelHideTimer();
		});
		panelEl.addEventListener("mouseleave", () => {
			this.scheduleHideCategoryPanel();
		});
		this.categoryPanelEl = panelEl;
		return panelEl;
	}

	/**
	 * 从菜单项的任意内部元素向上查找到 .menu-item 容器
	 */
	private resolveMenuItemContainerEl(candidate: HTMLElement | undefined): HTMLElement | null {
		if (!(candidate instanceof HTMLElement)) return null;
		if (candidate.classList.contains("menu-item")) return candidate;
		const closestMenuItem = candidate.closest(".menu-item");
		return closestMenuItem instanceof HTMLElement ? closestMenuItem : candidate;
	}

	/**
	 * 设置面板中当前高亮的菜单项
	 */
	private setCategoryPanelActiveItem(activeItemEl: HTMLElement): void {
		const panelEl = this.categoryPanelEl;
		if (!panelEl) return;
		for (const itemEl of Array.from(panelEl.querySelectorAll<HTMLElement>(".menu-item"))) {
			itemEl.classList.toggle("cna-text-menu-item-active", itemEl === activeItemEl);
		}
	}

	/**
	 * 清除面板中所有菜单项的高亮状态
	 */
	private clearCategoryPanelActiveState(panelEl: HTMLElement): void {
		for (const itemEl of Array.from(panelEl.querySelectorAll<HTMLElement>(".menu-item"))) {
			itemEl.classList.remove("cna-text-menu-item-active");
		}
	}

	/**
	 * 延迟隐藏面板（鼠标离开菜单项后等待一段时间，若没有进入面板则隐藏）
	 */
	private scheduleHideCategoryPanel(): void {
		if (this.categoryPanelHideTimer !== null) return;
		this.categoryPanelHideTimer = window.setTimeout(() => {
			this.categoryPanelHideTimer = null;
			this.hideCategoryPanelImmediate();
		}, 140);
	}

	/**
	 * 清除延迟隐藏定时器
	 */
	private clearCategoryPanelHideTimer(): void {
		if (this.categoryPanelHideTimer !== null) {
			window.clearTimeout(this.categoryPanelHideTimer);
			this.categoryPanelHideTimer = null;
		}
	}

	/**
	 * 立即隐藏分类面板
	 */
	private hideCategoryPanelImmediate(): void {
		this.clearCategoryPanelHideTimer();
		if (!this.categoryPanelEl) return;
		this.categoryPanelEl.hide();
	}

	/**
	 * 提高分类面板的 z-index，使其显示在所有原生菜单之上
	 */
	private elevateCategoryPanelAboveMenus(panelEl: HTMLElement): void {
		if (this.categoryPanelZIndex === null) {
			let maxMenuZIndex = 0;
			for (const menuEl of Array.from(document.querySelectorAll<HTMLElement>(".menu"))) {
				if (menuEl === panelEl) continue;
				const zIndexRaw = window.getComputedStyle(menuEl).zIndex;
				const zIndex = Number.parseInt(zIndexRaw, 10);
				if (Number.isFinite(zIndex)) {
					maxMenuZIndex = Math.max(maxMenuZIndex, zIndex);
				}
			}
			const layerMenuRaw = window.getComputedStyle(document.body).getPropertyValue("--layer-menu");
			const layerMenu = Number.parseInt(layerMenuRaw, 10);
			const baseZIndex = Number.isFinite(layerMenu) ? layerMenu : 1000;
			this.categoryPanelZIndex = Math.max(baseZIndex, maxMenuZIndex + 1);
		}
		panelEl.style.zIndex = String(this.categoryPanelZIndex);
		// 确保面板添加到 body 末尾，避免被其他元素遮盖
		if (panelEl.parentElement !== document.body || panelEl.nextElementSibling !== null) {
			document.body.appendChild(panelEl);
		}
	}

	// ==================== 添加词条逻辑 ====================

	/**
	 * 调用外部方法将选中的文本添加到指定的分类（H1）下，创建一个新的 H2 词条
	 * @param category 目标分类
	 * @param selectedText 用户选中的文本（作为新词条的名称）
	 */
	private async appendSettingToCategory(category: AddSettingCategoryItem, selectedText: string, isSpecial: boolean): Promise<void> {
		const normalizedText = normalizeSelection(selectedText);
		if (normalizedText.length === 0) return;
		let appendSucceeded = false;
		appendSucceeded = await appendGuidebookSettingToCategoryByPath(
			{
				app: this.plugin.app,
				t: this.t,
				treeData: this.cachedTreeData,
			},
			category.sourcePath,
			category.h1IndexInSource,
			normalizedText,
			category.title,
			isSpecial
		);
		if (!appendSucceeded) return;

		// 添加成功后关闭所有菜单并刷新树数据
		this.closeAddSettingMenus();
		this.scheduleTreeRefresh(this.resolveActiveFilePath());
	}

	/**
	 * 关闭所有打开的菜单和面板
	 */
	private closeAddSettingMenus(): void {
		this.hideCategoryPanelImmediate();
		this.activeAddSettingLevel1Menu?.hide();
		this.activeEditorContextMenu?.hide();
		this.activeAddSettingLevel1Menu = null;
		this.activeEditorContextMenu = null;
		this.categoryPanelZIndex = null;
		this.categoryPanelContentKey = null;
		// 发送 Escape 键事件，强制关闭可能残留的菜单层
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
		document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
	}

	// ==================== 数据刷新与缓存 ====================

	/**
	 * 防抖刷新树数据
	 */
	private scheduleTreeRefresh(filePath: string | null): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshTreeData(filePath);
		}, MENU_REFRESH_DELAY);
	}

	/**
	 * 异步刷新指南手册树数据（用于构建菜单）
	 * @param filePath 当前活跃文件路径（用于确定所属文库）
	 */
	private async refreshTreeData(filePath: string | null): Promise<void> {
		const token = ++this.refreshToken;
		if (!filePath) {
			if (token === this.refreshToken) this.cachedTreeData = null;
			return;
		}
		const treeData = await buildGuidebookTreeData(this.plugin.app, this.getSettings(), filePath);
		if (token !== this.refreshToken) return;
		this.cachedTreeData = treeData;
	}

	/**
	 * 获取当前活动 Markdown 文件的路径
	 */
	private resolveActiveFilePath(): string | null {
		return this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
	}

	/**
	 * 生成面板内容的唯一标识，用于判断是否需要重新渲染
	 * @param categories 分类列表
	 * @param selectedText 选中的文本
	 */
	private buildCategoryPanelKey(categories: AddSettingCategoryItem[], selectedText: string): string {
		const categoryKey = categories
			.map((c) => `${c.sourcePath}\u0000${c.h1IndexInSource}\u0000${c.title}`)
			.join("\u0001");
		return `${selectedText}\u0002${categoryKey}`;
	}
}

/**
 * 标准化选中的文本：去除首尾空白，若包含换行符或为空则返回空字符串
 */
function normalizeSelection(value: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) return "";
	if (/[\r\n]/.test(normalized)) return "";
	return normalized;
}
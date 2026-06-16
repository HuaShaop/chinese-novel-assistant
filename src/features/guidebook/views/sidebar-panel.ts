import { type PluginContext, UI, NovelLibraryService, NOVEL_LIBRARY_SUBDIR_NAMES, type VaultChangeEvent, watchVaultChanges } from "../../../core";
import { MarkdownView, setIcon, TFile, TFolder } from "obsidian";
import { ClearableInputComponent, ToggleButtonComponent } from "../../../ui";
import { createGuidebookTreeViewComponent, type GuidebookTreeExpandedStateSnapshot } from "./outline-tree";
import { buildGuidebookTreeData, type GuidebookTreeData } from "../tree-builder";
import { filterGuidebookTreeByKeyword } from "./search-box";
import {
	handleGuidebookBlankCreateCollection,
	handleGuidebookFileContextAction,
	handleGuidebookH1ContextAction,
	handleGuidebookH2ContextAction,
} from "../menu-actions";
import { handleGuidebookTreeDragMove } from "../drag-sort-actions";
import { logger } from "../../../utils/logger";

let cachedMarkdownFilePath: string | null = null;

/**
 * 渲染指南手册侧边栏面板。
 * 
 * 该函数创建并管理整个指南手册树形视图的 UI，包括：
 * - 标题栏与工具栏（展开/折叠按钮、搜索框）
 * - 动态加载和刷新树状数据
 * - 处理文件/章节的右键菜单操作（新建、重命名、删除、拖拽排序）
 * - 监听仓库变化（文件重命名、内容修改）并自动刷新
 * - 持久化树节点的展开/折叠状态
 * 
 * @param containerEl - 侧边栏的父容器元素
 * @param ctx - 插件上下文，包含 app、设置、国际化等工具
 * @returns 清理函数，用于卸载时释放资源
 */
export function renderGuidebookSidebarPanel(containerEl: HTMLElement, ctx: PluginContext): () => void {
	// ============ 1. 创建 DOM 结构（根容器、头部、搜索区、滚动区） ============
	const rootEl = containerEl.createDiv({ cls: "cna-right-sidebar-guidebook" });
	const headerEl = rootEl.createDiv({ cls: "cna-right-sidebar-guidebook__header" });
	headerEl.createDiv({ cls: "cna-right-sidebar-guidebook__header-spacer" });

	const titleEl = headerEl.createDiv({ cls: "cna-right-sidebar-guidebook__title" });
	const titleIconEl = titleEl.createSpan({ cls: "cna-right-sidebar-guidebook__title-icon" });
	setIcon(titleIconEl, UI.ICON.PLUGIN);
	const titleTextEl = titleEl.createSpan({ cls: "cna-right-sidebar-guidebook__title-text" });

	rootEl.createDiv({ cls: "cna-right-sidebar-guidebook__divider" });
	const contentEl = rootEl.createDiv({ cls: "cna-right-sidebar-guidebook__content" });
	const searchWrapEl = contentEl.createDiv({ cls: "cna-right-sidebar-guidebook__search-wrap" });
	const scrollEl = contentEl.createDiv({ cls: "cna-right-sidebar-guidebook__scroll" });

	// ============ 2. 状态变量定义 ============
	let searchKeyword = "";
	let searchCountEl: HTMLElement | null = null;
	let latestTreeData: GuidebookTreeData | null = null;
	let persistExpandedStateTimer: number | null = null;
	let pendingExpandedState: GuidebookTreeExpandedStateSnapshot | null = null;
	let isDisposed = false;
	let refreshSeq = 0;
	let refreshTimer: number | null = null;
	let renderedTreeSignature: string | null = null;
	let hasRenderedTree = false;
	let lastMarkdownFilePath = resolveActiveMarkdownFilePath(ctx) ?? cachedMarkdownFilePath;
	if (lastMarkdownFilePath) {
		cachedMarkdownFilePath = lastMarkdownFilePath;
	}

	// ============ 3. 辅助函数：持久化展开状态（防抖） ============
	const schedulePersistExpandedState = (snapshot: GuidebookTreeExpandedStateSnapshot): void => {
		pendingExpandedState = snapshot;
		if (persistExpandedStateTimer !== null) {
			window.clearTimeout(persistExpandedStateTimer);
		}
		persistExpandedStateTimer = window.setTimeout(() => {
			persistExpandedStateTimer = null;
			const nextSnapshot = pendingExpandedState;
			pendingExpandedState = null;
			if (!nextSnapshot) return;
			const settings = ctx.settings;
			if (
				settings.guidebookTreeAllExpanded === nextSnapshot.allExpanded &&
				areExpandedStateRecordsEqual(settings.guidebookTreeExpandedStates ?? {}, nextSnapshot.nodeExpandedState)
			) {
				return;
			}
			void ctx.setSettings({
				guidebookTreeAllExpanded: nextSnapshot.allExpanded,
				guidebookTreeExpandedStates: nextSnapshot.nodeExpandedState,
			});
		}, 120);
	};

	// ============ 4. 恢复/初始化树展开状态 ============
	const rawExpandedState = ctx.settings.guidebookTreeExpandedStates ?? {};
	const initialExpandedState = filterGuidebookTreeExpandedState(rawExpandedState);
	const initialAllExpanded = ctx.settings.guidebookTreeAllExpanded ?? true;
	if (!areExpandedStateRecordsEqual(rawExpandedState, initialExpandedState)) {
		void ctx.setSettings({ guidebookTreeExpandedStates: initialExpandedState });
	}

	// ============ 5. 创建树形视图组件（注册所有右键菜单回调） ============
	//done: 处理右键event的不同表现
	const treeView = createGuidebookTreeViewComponent(scrollEl, {
		menuLabels: {
			createCollection: ctx.t("feature.guidebook.menu.create_collection"),
			renameCollection: ctx.t("feature.guidebook.menu.rename_collection"),
			deleteCollection: ctx.t("feature.guidebook.menu.delete_collection"),
			createCategory: ctx.t("feature.guidebook.menu.create_category"),
			renameCategory: ctx.t("feature.guidebook.menu.rename_category"),
			deleteCategory: ctx.t("feature.guidebook.menu.delete_category"),
			createSetting: ctx.t("feature.guidebook.menu.create_setting"),
			renameSetting: ctx.t("feature.guidebook.menu.rename_setting"),
			deleteSetting: ctx.t("feature.guidebook.menu.delete_setting"),
			editSetting: ctx.t("feature.guidebook.menu.edit_setting"),
		},
		onFileContextAction: (action, fileNode) => {
			void (async () => {
				const changed = await handleGuidebookFileContextAction(
					{ app: ctx.app, t: (key) => ctx.t(key), treeData: latestTreeData, openFileInNewTab: ctx.settings.openFileInNewTab },
					action,
					fileNode,
				);
				if (changed) void refreshGuidebook();
			})();
		},
		onH1ContextAction: (action, fileNode, h1Node) => {
			void (async () => {
				const changed = await handleGuidebookH1ContextAction(
					{ app: ctx.app, t: (key) => ctx.t(key), treeData: latestTreeData, openFileInNewTab: ctx.settings.openFileInNewTab },
					action,
					fileNode,
					h1Node,
				);
				if (changed) void refreshGuidebook();
			})();
		},
		onH2ContextAction: (action, fileNode, h1Node, h2Node) => {
			void (async () => {
				const changed = await handleGuidebookH2ContextAction(
					{ app: ctx.app, t: (key) => ctx.t(key), treeData: latestTreeData, openFileInNewTab: ctx.settings.openFileInNewTab },
					action,
					fileNode,
					h1Node,
					h2Node,
				);
				if (changed) void refreshGuidebook();
			})();
		},
		onBlankContextCreateCollection: () => {
			void (async () => {
				const changed = await handleGuidebookBlankCreateCollection({
					app: ctx.app,
					t: (key) => ctx.t(key),
					treeData: latestTreeData,
					openFileInNewTab: ctx.settings.openFileInNewTab,
				});
				if (changed) void refreshGuidebook();
			})();
		},
		onMove: (request) => {
			return (async () => {
				const changed = await handleGuidebookTreeDragMove(
					{ app: ctx.app, t: (key) => ctx.t(key), treeData: latestTreeData, getSettings: () => ctx.settings, setSettings: (patch) => ctx.setSettings(patch) },
					request,
				);
				if (changed) void refreshGuidebook();
				return changed;
			})();
		},
		initialExpandedState,
		initialAllExpanded,
		onExpandedStateChange: schedulePersistExpandedState,
	});

	// ============ 6. 头部按钮：展开/折叠切换 ============
	const toggleButton = new ToggleButtonComponent({
		containerEl: headerEl,
		className: "cna-right-sidebar-guidebook__toggle-button",
		onIcon: UI.ICON.COLLAPSE,
		offIcon: UI.ICON.EXPAND,
		onTooltip: ctx.t("feature.guidebook.action.collapse_all"),
		offTooltip: ctx.t("feature.guidebook.action.expand_all"),
		initialOn: initialAllExpanded,
		onToggle: (isOn) => treeView.setAllExpanded(isOn),
	});

	// ============ 7. 搜索输入框组件与计数显示 ============
	new ClearableInputComponent({
		containerEl: searchWrapEl,
		containerClassName: "cna-guidebook-search-input-container",
		placeholder: "",
		onChange: (value) => {
			searchKeyword = value;
			applySearchFilterAndRender();
		},
	});
	const searchInputContainerEl = searchWrapEl.querySelector<HTMLElement>(".cna-guidebook-search-input-container");
	searchCountEl = searchInputContainerEl?.createSpan({ cls: "cna-guidebook-search-count", text: "0" }) ?? null;
	const searchInputEl = searchWrapEl.querySelector<HTMLInputElement>("input");
	const searchClearButtonEl = searchWrapEl.querySelector<HTMLElement>(".search-input-clear-button");

	// ============ 8. 内部函数：计算总 H2 数量 ============
	const resolveTotalH2Count = (treeData: GuidebookTreeData | null): number => {
		if (!treeData) return 0;
		return treeData.files.reduce((total, fileNode) => total + fileNode.h2Count, 0);
	};

	// ============ 9. 内部函数：应用搜索过滤并渲染树 ============
	const applySearchFilterAndRender = (forceRender = false): void => {
		const { treeData: filteredTreeData, matchedH2Count } = filterGuidebookTreeByKeyword(latestTreeData, searchKeyword);
		const visibleCount = Math.max(0, matchedH2Count);
		const totalCount = Math.max(0, resolveTotalH2Count(latestTreeData));
		const hasFilter = searchKeyword.trim().length > 0;
		searchCountEl?.setText(hasFilter ? `${visibleCount}/${totalCount}` : `${totalCount}`);
		const treeSignature = buildGuidebookTreeSignature(filteredTreeData);
		if (!forceRender && hasRenderedTree && treeSignature === renderedTreeSignature) return;
		renderedTreeSignature = treeSignature;
		hasRenderedTree = true;
		treeView.renderData(filteredTreeData, ctx.t("feature.guidebook.tree.empty"));
	};

	// ============ 10. 内部函数：更新本地化文本（搜索框占位符等） ============
	const updateLocalizedText = (): void => {
		searchInputEl?.setAttr("placeholder", ctx.t("feature.guidebook.search.placeholder"));
		searchClearButtonEl?.setAttr("aria-label", ctx.t("feature.guidebook.search.clear"));
	};

	// ============ 11. 内部函数：刷新指南手册数据（防抖内调用） ============
	const refreshGuidebook = async (preferredFilePath?: string | null): Promise<void> => {
		const nextFilePath = preferredFilePath ?? resolveActiveMarkdownFilePath(ctx) ?? lastMarkdownFilePath ?? cachedMarkdownFilePath;
		if (nextFilePath) {
			lastMarkdownFilePath = nextFilePath;
			cachedMarkdownFilePath = nextFilePath;
		}
		titleTextEl.setText(resolveCurrentNovelLibraryName(ctx, new NovelLibraryService(ctx.app), nextFilePath));
		const currentSeq = ++refreshSeq;
		if (!hasRenderedTree) treeView.renderLoading(ctx.t("feature.guidebook.tree.loading"));
		const treeData = (await loadGuidebookTreeData(ctx, nextFilePath ?? null)) ?? null;
		if (isDisposed || currentSeq !== refreshSeq) return;
		latestTreeData = treeData;
		applySearchFilterAndRender();
	};

	// ============ 12. 内部函数：调度刷新（防抖） ============
	const scheduleRefresh = (preferredFilePath?: string | null): void => {
		if (refreshTimer !== null) window.clearTimeout(refreshTimer);
		refreshTimer = window.setTimeout(() => {
			refreshTimer = null;
			void refreshGuidebook(preferredFilePath);
		}, 120);
	};

	// ============ 13. 初始渲染与本地化 ============
	updateLocalizedText();
	void refreshGuidebook();

	// ============ 14. 设置工作区事件监听（文件打开、活动叶子变化） ============
	const workspaceEventRefs = [
		ctx.app.workspace.on("file-open", (file) => {
			scheduleRefresh(file?.path ?? null);
		}),
		ctx.app.workspace.on("active-leaf-change", (leaf) => {
			const markdownView = leaf?.view;
			if (!(markdownView instanceof MarkdownView)) return;
			scheduleRefresh(markdownView.file?.path ?? null);
		}),
	];

	// ============ 15. 设置仓库变化监听（文件/文件夹重命名、内容修改） ============
	const disposeVaultWatcher = watchVaultChanges(ctx.app, (event) => {
		if (event.file instanceof TFolder) {
			if (shouldRefreshForLibraryFolderRename(event, ctx, new NovelLibraryService(ctx.app))) {
				scheduleRefresh(event.path);
			}
			return;
		}
		if (!isMarkdownFile(event.file)) return;
		if (shouldRefreshForVaultEvent(event, ctx, new NovelLibraryService(ctx.app), latestTreeData, lastMarkdownFilePath)) {
			scheduleRefresh();
		}
	});

	// ============ 16. 设置设置变更监听（语言、排序等变化时刷新） ============
	const disposeSettingsChange = ctx.onSettingsChange(() => {
		updateLocalizedText();
		applySearchFilterAndRender(true);
		void refreshGuidebook();
	});

	// ============ 17. 返回清理函数，释放所有资源 ============
	return () => {
		isDisposed = true;
		refreshSeq += 1;
		if (refreshTimer !== null) window.clearTimeout(refreshTimer);
		if (persistExpandedStateTimer !== null) window.clearTimeout(persistExpandedStateTimer);
		toggleButton.destroy();
		treeView.destroy();
		for (const eventRef of workspaceEventRefs) ctx.app.workspace.offref(eventRef);
		disposeVaultWatcher();
		disposeSettingsChange();
	};
}

function resolveCurrentNovelLibraryName(
	ctx: PluginContext,
	novelLibraryService: NovelLibraryService,
	filePath?: string | null,
): string {
	const activeFilePath = typeof filePath === "string" && filePath.length > 0 ? filePath : null;
	if (!activeFilePath) {
		return ctx.t("feature.guidebook.current_library.none");
	}

	const settings = ctx.settings;
	const libraryRoots = novelLibraryService.normalizeLibraryRoots(settings.novelLibraries);
	const matchedLibraryPath = novelLibraryService.resolveContainingLibraryRoot(activeFilePath, libraryRoots);
	if (!matchedLibraryPath) {
		return ctx.t("feature.guidebook.current_library.none");
	}

	const segments = matchedLibraryPath.split("/").filter((segment) => segment.length > 0);
	return segments[segments.length - 1] ?? matchedLibraryPath;
}

function resolveActiveMarkdownFilePath(ctx: PluginContext): string | null {
	const activeView = ctx.app.workspace.getActiveViewOfType(MarkdownView);
	return activeView?.file?.path ?? null;
}

async function loadGuidebookTreeData(
	ctx: PluginContext,
	activeFilePath: string | null,
): Promise<GuidebookTreeData | null> {
	return buildGuidebookTreeData(
		ctx.app,
		{
			locale: ctx.settings.locale,
			novelLibraries: ctx.settings.novelLibraries,
			guidebookCollectionOrders: ctx.settings.guidebookCollectionOrders,
		},
		activeFilePath,
	);
}

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function shouldRefreshForVaultEvent(
	event: VaultChangeEvent,
	ctx: PluginContext,
	novelLibraryService: NovelLibraryService,
	latestTreeData: GuidebookTreeData | null,
	lastMarkdownFilePath: string | null,
): boolean {
	const settings = ctx.settings;
	const normalizedLibraryRoots = novelLibraryService.normalizeLibraryRoots(settings.novelLibraries);
	const referenceFilePath = resolveActiveMarkdownFilePath(ctx) ?? lastMarkdownFilePath ?? cachedMarkdownFilePath;
	if (!referenceFilePath) {
		return true;
	}

	const activeLibraryRoot = novelLibraryService.resolveContainingLibraryRoot(referenceFilePath, normalizedLibraryRoots);
	if (!activeLibraryRoot) {
		return false;
	}
	const guidebookRootPath =
		latestTreeData?.guidebookRootPath ||
		novelLibraryService.resolveNovelLibrarySubdirPath(activeLibraryRoot,
			NOVEL_LIBRARY_SUBDIR_NAMES.guidebook,
		);
	if (!guidebookRootPath) {
		return false;
	}
	return isSameOrChildPath(event.path, guidebookRootPath) || isSameOrChildPath(event.oldPath, guidebookRootPath);
}

function shouldRefreshForLibraryFolderRename(
	event: VaultChangeEvent,
	ctx: PluginContext,
	novelLibraryService: NovelLibraryService,
): boolean {
	const renamedFolderPath = novelLibraryService.normalizeVaultPath(event.path);
	const previousFolderPath = novelLibraryService.normalizeVaultPath(event.oldPath ?? "");
	if (!renamedFolderPath || !previousFolderPath || renamedFolderPath === previousFolderPath) {
		return false;
	}
	const libraryRoots = novelLibraryService.normalizeLibraryRoots(ctx.settings.novelLibraries);
	if (libraryRoots.length === 0) {
		return false;
	}
	return libraryRoots.some((libraryRoot) =>
		novelLibraryService.isSameOrChildPath(libraryRoot, previousFolderPath) ||
		novelLibraryService.isSameOrChildPath(previousFolderPath, libraryRoot) ||
		novelLibraryService.isSameOrChildPath(libraryRoot, renamedFolderPath) ||
		novelLibraryService.isSameOrChildPath(renamedFolderPath, libraryRoot),
	);
}

function isSameOrChildPath(path: string | undefined, root: string): boolean {
	if (!path || !root) {
		return false;
	}
	return path === root || path.startsWith(`${root}/`);
}

function buildGuidebookTreeSignature(treeData: GuidebookTreeData | null): string {
	if (!treeData) {
		return "";
	}
	let signature = `${treeData.libraryRootPath}\u0000${treeData.guidebookRootPath}\u0000${treeData.files.length}`;
	for (const fileNode of treeData.files) {
		signature += `\u0001${fileNode.stableKey}\u0000${fileNode.fileName}\u0000${fileNode.h2Count}\u0000${fileNode.sourcePaths.join("\u0002")}`;
		for (const h1Node of fileNode.h1List) {
			signature += `\u0003${h1Node.h1IndexInSource}\u0000${h1Node.title}\u0000${h1Node.h2List.length}\u0000${h1Node.sourcePath}`;
			for (const h2Node of h1Node.h2List) {
				signature += `\u0004${h2Node.h1IndexInSource}\u0000${h2Node.h2IndexInH1}\u0000${h2Node.title}\u0000${h2Node.sourcePath}\u0000${h2Node.sourceFileCtime}\u0000${h2Node.sourceFileMtime}`;
			}
		}
	}
	return signature;
}

function areExpandedStateRecordsEqual(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) {
		return false;
	}
	for (const key of leftKeys) {
		if (left[key] !== right[key]) {
			return false;
		}
	}
	return true;
}

function filterGuidebookTreeExpandedState(source: Record<string, boolean>): Record<string, boolean> {
	const next: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(source)) {
		if (!key.includes("::file:") && !key.includes("::h1:")) {
			continue;
		}
		next[key] = value;
	}
	return next;
}










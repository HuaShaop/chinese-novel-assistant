import type { EditorView } from "@codemirror/view";
import { MarkdownView, TFile, TFolder, type Plugin } from "obsidian";
import { GuidebookMarkdownParser } from "../../guidebook";
import { collectGuidebookAliases } from "../../guidebook/alias-utils";
import { NovelLibraryService, NOVEL_LIBRARY_SUBDIR_NAMES, GUIDEBOOK_SUBDIR_NAMES, type SettingDatas, listMarkdownFilesInFolder } from "../../../core";
import { resolveMarkdownViewByEditorView } from "../../../utils";
import type { TextDetectionRange, TextDetectionRule } from "../engine";
import { logger } from "../../../utils/logger";

const GUIDEBOOK_KEYWORD_HIT_CLASS = "cna-guidebook-keyword-hit";
const GUIDEBOOK_KEYWORD_BACKGROUND_VAR = "--cna-guidebook-keyword-background-color";
const GUIDEBOOK_KEYWORD_UNDERLINE_STYLE_VAR = "--cna-guidebook-keyword-underline-style";
const GUIDEBOOK_KEYWORD_UNDERLINE_WIDTH_VAR = "--cna-guidebook-keyword-underline-width";
const GUIDEBOOK_KEYWORD_UNDERLINE_COLOR_VAR = "--cna-guidebook-keyword-underline-color";
const GUIDEBOOK_KEYWORD_FONT_WEIGHT_VAR = "--cna-guidebook-keyword-font-weight";
const GUIDEBOOK_KEYWORD_FONT_STYLE_VAR = "--cna-guidebook-keyword-font-style";
const GUIDEBOOK_KEYWORD_TEXT_COLOR_VAR = "--cna-guidebook-keyword-text-color";

interface MatchRange {
	from: number;
	to: number;
}

export interface GuidebookKeywordPreviewItem {
	keyword: string;
	title: string;
	categoryTitle: string;
	content: string;
	sourcePath: string;
}

interface GuidebookFileKeywordCacheEntry {
	mtime: number;
	size: number;
	keywords: readonly string[];
	keywordMatchGroups: readonly (readonly string[])[];
	previewsByKeyword: ReadonlyMap<string, GuidebookKeywordPreviewItem>;
}

interface GuidebookLibraryKeywordIndex {
	keywords: readonly string[];
	keywordMatchGroups: readonly (readonly string[])[];
	previewsByKeyword: ReadonlyMap<string, GuidebookKeywordPreviewItem>;
}

export class GuidebookKeywordHighlightController {
	private readonly plugin: Plugin;
	private readonly getSettings: () => SettingDatas;
	private readonly shouldDetectInView: (view: EditorView) => boolean;
	private readonly forceRefreshEditorViews: () => void;
	private readonly novelLibraryService: NovelLibraryService;
	private readonly guidebookMarkdownParser: GuidebookMarkdownParser;
	private readonly guidebookKeywordsByLibraryRoot = new Map<string, readonly string[]>();
	private readonly guidebookKeywordMatchGroupsByLibraryRoot = new Map<string, readonly (readonly string[])[]>();
	private readonly guidebookKeywordPreviewByLibraryRoot = new Map<string, ReadonlyMap<string, GuidebookKeywordPreviewItem>>();
	private readonly loadingGuidebookKeywordRoots = new Set<string>();
	private readonly dirtyGuidebookKeywordRoots = new Set<string>();
	private readonly guidebookFileKeywordCacheByPath = new Map<string, GuidebookFileKeywordCacheEntry>();
	private guidebookKeywordRefreshTimer: number | null = null;
	private keywordCacheVersion = 0;
	private isDisposed = false;
	private readonly mappedDirs = [
		GUIDEBOOK_SUBDIR_NAMES.characterSetting,
		GUIDEBOOK_SUBDIR_NAMES.factionSetting,
		GUIDEBOOK_SUBDIR_NAMES.locationSetting,
	];

	constructor(
		plugin: Plugin,
		getSettings: () => SettingDatas,
		shouldDetectInView: (view: EditorView) => boolean,
		forceRefreshEditorViews: () => void,
	) {
		this.plugin = plugin;
		this.getSettings = getSettings;
		this.shouldDetectInView = shouldDetectInView;
		this.forceRefreshEditorViews = forceRefreshEditorViews;
		this.novelLibraryService = new NovelLibraryService(plugin.app);
		this.guidebookMarkdownParser = new GuidebookMarkdownParser();
	}

	getRules(): TextDetectionRule[] {
		return createGuidebookKeywordRules(
			() => this.getSettings(),
			(view) => this.getGuidebookKeywordsByEditorView(view),
			(view) => this.getGuidebookKeywordMatchGroupsByEditorView(view),
			(view) => this.shouldDetectInView(view),
		);
	}

	applyInitialState(): void {
		this.applyStyles();
		this.schedulePrefetchKeywords();
	}

	handleSettingsChange(): void {
		this.clearKeywordCache();
		this.schedulePrefetchKeywords();
		this.applyStyles();
	}

	handleFilePathHint(filePath?: string | null): void {
		this.schedulePrefetchKeywords(filePath ?? null);
	}

	handleVaultChange(path: string, oldPath?: string | null): boolean {
		if (!this.isGuidebookPath(path) && !this.isGuidebookPath(oldPath ?? null)) {
			return false;
		}
		const affectedLibraryRoots = new Set<string>();
		const currentLibraryRoot = this.resolveContainingLibraryRoot(path);
		if (currentLibraryRoot) {
			affectedLibraryRoots.add(currentLibraryRoot);
		}
		const previousLibraryRoot = this.resolveContainingLibraryRoot(oldPath ?? null);
		if (previousLibraryRoot) {
			affectedLibraryRoots.add(previousLibraryRoot);
		}
		for (const libraryRoot of affectedLibraryRoots) {
			this.dirtyGuidebookKeywordRoots.add(libraryRoot);
		}
		this.schedulePrefetchKeywords(path);
		return true;
	}

	dispose(): void {
		this.isDisposed = true;
		if (this.guidebookKeywordRefreshTimer !== null) {
			window.clearTimeout(this.guidebookKeywordRefreshTimer);
			this.guidebookKeywordRefreshTimer = null;
		}
		this.clearStyles();
		this.clearKeywordCache();
	}

	getPreviewItemByEditorView(editorView: EditorView, rawKeyword: string): GuidebookKeywordPreviewItem | null {
		if (!this.shouldDetectInView(editorView)) {
			return null;
		}
		const keyword = rawKeyword.trim();
		if (keyword.length === 0) {
			return null;
		}
		const markdownView = resolveMarkdownViewByEditorView(this.plugin.app, editorView);
		const filePath = markdownView?.file?.path ?? null;
		const libraryRoot = this.resolveContainingLibraryRoot(filePath);
		if (!libraryRoot) {
			return null;
		}
		const previewMap = this.guidebookKeywordPreviewByLibraryRoot.get(libraryRoot);
		if (previewMap) {
			const exactPreview = previewMap.get(keyword);
			if (exactPreview) {
				return exactPreview;
			}
			return this.resolveMergedKeywordPreviewItem(keyword, previewMap);
		}
		void (async () => {
			const changed = await this.refreshKeywordsForLibrary(libraryRoot);
			if (changed) {
				this.forceRefreshEditorViews();
			}
		})();
		return null;
	}

	hasKeywordInEditorView(editorView: EditorView, rawKeyword: string): boolean {
		if (!this.shouldDetectInView(editorView)) {
			return false;
		}
		const keyword = rawKeyword.trim();
		if (keyword.length === 0) {
			return false;
		}
		const keywords = this.getGuidebookKeywordsByEditorView(editorView);
		return keywords.includes(keyword);
	}

	private resolveMergedKeywordPreviewItem(
		rawKeyword: string,
		previewMap: ReadonlyMap<string, GuidebookKeywordPreviewItem>,
	): GuidebookKeywordPreviewItem | null {
		const mergedKeyword = rawKeyword.trim();
		if (mergedKeyword.length === 0) {
			return null;
		}

		let resolvedPreviewItem: GuidebookKeywordPreviewItem | null = null;
		const previewIdentitySet = new Set<string>();
		let matchedKeywordCount = 0;
		const matchedRanges: TextDetectionRange[] = [];

		for (const [candidateKeyword, candidatePreviewItem] of previewMap) {
			if (!candidateKeyword || candidateKeyword.length === 0 || candidateKeyword === mergedKeyword) {
				continue;
			}
			if (!mergedKeyword.includes(candidateKeyword)) {
				continue;
			}
			matchedKeywordCount += 1;
			const identity = `${candidatePreviewItem.sourcePath}\u0000${candidatePreviewItem.categoryTitle}\u0000${candidatePreviewItem.title}`;
			if (!previewIdentitySet.has(identity)) {
				previewIdentitySet.add(identity);
				resolvedPreviewItem = candidatePreviewItem;
				if (previewIdentitySet.size > 1) {
					return null;
				}
			}

			let searchCursor = 0;
			while (searchCursor < mergedKeyword.length) {
				const matchIndex = mergedKeyword.indexOf(candidateKeyword, searchCursor);
				if (matchIndex < 0) {
					break;
				}
				matchedRanges.push({
					from: matchIndex,
					to: matchIndex + candidateKeyword.length,
				});
				searchCursor = matchIndex + candidateKeyword.length;
			}
		}

		if (matchedKeywordCount < 2 || !resolvedPreviewItem) {
			return null;
		}

		const covered = new Array<boolean>(mergedKeyword.length).fill(false);
		for (const range of matchedRanges) {
			const from = Math.max(0, Math.min(mergedKeyword.length, range.from));
			const to = Math.max(0, Math.min(mergedKeyword.length, range.to));
			for (let index = from; index < to; index += 1) {
				covered[index] = true;
			}
		}
		if (covered.some((value) => !value)) {
			return null;
		}
		return resolvedPreviewItem;
	}

	private getGuidebookKeywordsByEditorView(editorView: EditorView): readonly string[] {
		const markdownView = resolveMarkdownViewByEditorView(this.plugin.app, editorView);
		const filePath = markdownView?.file?.path ?? null;
		const libraryRoot = this.resolveContainingLibraryRoot(filePath);
		if (!libraryRoot) {
			return [];
		}

		const cached = this.guidebookKeywordsByLibraryRoot.get(libraryRoot);
		if (cached) {
			return cached;
		}

		void (async () => {
			const changed = await this.refreshKeywordsForLibrary(libraryRoot);
			if (changed) {
				this.forceRefreshEditorViews();
			}
		})();
		return [];
	}

	private getGuidebookKeywordMatchGroupsByEditorView(editorView: EditorView): readonly (readonly string[])[] {
		const markdownView = resolveMarkdownViewByEditorView(this.plugin.app, editorView);
		const filePath = markdownView?.file?.path ?? null;
		const libraryRoot = this.resolveContainingLibraryRoot(filePath);
		if (!libraryRoot) {
			return [];
		}

		const cached = this.guidebookKeywordMatchGroupsByLibraryRoot.get(libraryRoot);
		if (cached) {
			return cached;
		}

		void (async () => {
			const changed = await this.refreshKeywordsForLibrary(libraryRoot);
			if (changed) {
				this.forceRefreshEditorViews();
			}
		})();
		return [];
	}

	private schedulePrefetchKeywords(preferredFilePath?: string | null): void {
		if (this.isDisposed) {
			return;
		}
		if (this.guidebookKeywordRefreshTimer !== null) {
			window.clearTimeout(this.guidebookKeywordRefreshTimer);
		}
		this.guidebookKeywordRefreshTimer = window.setTimeout(() => {
			this.guidebookKeywordRefreshTimer = null;
			void this.prefetchKeywords(preferredFilePath ?? null);
		}, 120);
	}

	private async prefetchKeywords(preferredFilePath: string | null): Promise<void> {
		if (this.isDisposed) {
			return;
		}
		this.pruneKeywordCache();

		const libraryRoots = new Set<string>();
		if (preferredFilePath) {
			const preferredLibraryRoot = this.resolveContainingLibraryRoot(preferredFilePath);
			if (preferredLibraryRoot) {
				libraryRoots.add(preferredLibraryRoot);
			}
		}
		const activeFilePath = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
		if (activeFilePath) {
			const activeLibraryRoot = this.resolveContainingLibraryRoot(activeFilePath);
			if (activeLibraryRoot) {
				libraryRoots.add(activeLibraryRoot);
			}
		}
		for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file?.path) {
				continue;
			}
			const libraryRoot = this.resolveContainingLibraryRoot(view.file.path);
			if (!libraryRoot) {
				continue;
			}
			libraryRoots.add(libraryRoot);
		}

		const refreshTasks: Promise<boolean>[] = [];
		for (const libraryRoot of libraryRoots) {
			const shouldRefresh =
				this.dirtyGuidebookKeywordRoots.has(libraryRoot) ||
				!this.guidebookKeywordsByLibraryRoot.has(libraryRoot);
			if (!shouldRefresh) {
				continue;
			}
			refreshTasks.push(this.refreshKeywordsForLibrary(libraryRoot));
		}
		if (refreshTasks.length > 0) {
			const results = await Promise.all(refreshTasks);
			if (results.some((value) => value)) {
				this.forceRefreshEditorViews();
			}
		}
	}

	private async refreshKeywordsForLibrary(libraryRootPath: string): Promise<boolean> {
		if (!libraryRootPath || this.isDisposed || this.loadingGuidebookKeywordRoots.has(libraryRootPath)) {
			return false;
		}

		this.loadingGuidebookKeywordRoots.add(libraryRootPath);
		const cacheVersionAtStart = this.keywordCacheVersion;
		try {
			const keywordIndex = await this.collectGuidebookKeywordIndex(libraryRootPath);
			if (this.isDisposed || cacheVersionAtStart !== this.keywordCacheVersion) {
				return false;
			}
			const { keywords, keywordMatchGroups, previewsByKeyword } = keywordIndex;
			const previousKeywords = this.guidebookKeywordsByLibraryRoot.get(libraryRootPath) ?? [];
			const previousKeywordMatchGroups = this.guidebookKeywordMatchGroupsByLibraryRoot.get(libraryRootPath) ?? [];
			this.guidebookKeywordPreviewByLibraryRoot.set(libraryRootPath, previewsByKeyword);
			this.guidebookKeywordMatchGroupsByLibraryRoot.set(libraryRootPath, keywordMatchGroups);
			if (
				areKeywordListsEqual(previousKeywords, keywords) &&
				areKeywordMatchGroupsEqual(previousKeywordMatchGroups, keywordMatchGroups)
			) {
				this.dirtyGuidebookKeywordRoots.delete(libraryRootPath);
				return false;
			}
			this.guidebookKeywordsByLibraryRoot.set(libraryRootPath, keywords);
			this.dirtyGuidebookKeywordRoots.delete(libraryRootPath);
			return true;
		} finally {
			this.loadingGuidebookKeywordRoots.delete(libraryRootPath);
		}
	}

	private isPathInOtherSetting(filePath: string, guidebookRootPath: string): boolean {
		const otherSettingDir = `${guidebookRootPath}/${GUIDEBOOK_SUBDIR_NAMES.otherSetting}`;
		return filePath.startsWith(otherSettingDir);
	}

	private isPathInFolderMappedSetting(filePath: string, guidebookRootPath: string): boolean {
		for (const dir of this.mappedDirs) {
			const dirPath = `${guidebookRootPath}/${dir}`;
			if (filePath.startsWith(dirPath)) {
				// 确保至少有一层子文件夹（即设定目录后还有路径分隔符）
				const relative = filePath.slice(dirPath.length + 1);
				if (relative.includes('/')) {
					return true;
				}
			}
		}
		return false;
	}

	// ========== 修改后的 collectGuidebookKeywordIndex ==========
	private async collectGuidebookKeywordIndex(libraryRootPath: string): Promise<GuidebookLibraryKeywordIndex> {
		const guidebookRootPath = this.novelLibraryService.resolveNovelLibrarySubdirPath(
			libraryRootPath,
			NOVEL_LIBRARY_SUBDIR_NAMES.guidebook,
		);
		if (!guidebookRootPath) {
			return {
				keywords: [],
				keywordMatchGroups: [],
				previewsByKeyword: new Map(),
			};
		}

		const allMarkdownFiles: TFile[] = [];
		// 1. 其他设定：直接收集所有 .md 文件
		const otherSettingPath = `${guidebookRootPath}/${GUIDEBOOK_SUBDIR_NAMES.otherSetting}`;
		const otherSettingFiles = listMarkdownFilesInFolder(this.plugin.app, otherSettingPath);
		allMarkdownFiles.push(...otherSettingFiles);
		// 2. 人物设定、势力设定、地点设定：收集子文件夹中的 .md 文件
		for (const dir of this.mappedDirs) {
			const dirPath = `${guidebookRootPath}/${dir}`;
			const dirAbstract = this.plugin.app.vault.getAbstractFileByPath(dirPath);
			if (dirAbstract instanceof TFolder) {
				for (const child of dirAbstract.children) {
					if (child instanceof TFolder) {
						const mdFiles = listMarkdownFilesInFolder(this.plugin.app, child.path);
						allMarkdownFiles.push(...mdFiles);
					}
				}
			}
		}

		// 按 ctime 排序
		allMarkdownFiles.sort((a, b) => a.stat.ctime - b.stat.ctime || a.path.localeCompare(b.path));

		const keywordSet = new Set<string>();
		const keywordMatchGroups: string[][] = [];
		const groupedKeywordSet = new Set<string>();
		const previewsByKeyword = new Map<string, GuidebookKeywordPreviewItem>();
		const activeGuidebookPaths = new Set<string>();

		for (const file of allMarkdownFiles) {
			activeGuidebookPaths.add(file.path);
			const fileKeywordIndex = await this.resolveGuidebookFileKeywordIndex(
				file.path,
				file.stat.mtime,
				file.stat.size,
			);
			for (const kw of fileKeywordIndex.keywords) {
				keywordSet.add(kw);
			}
			for (const [kw, preview] of fileKeywordIndex.previewsByKeyword) {
				if (!previewsByKeyword.has(kw)) {
					previewsByKeyword.set(kw, preview);
				}
			}
			for (const group of fileKeywordIndex.keywordMatchGroups) {
				const uniqueGroup: string[] = [];
				for (const kw of group) {
					if (groupedKeywordSet.has(kw)) {
						continue;
					}
					groupedKeywordSet.add(kw);
					uniqueGroup.push(kw);
				}
				if (uniqueGroup.length > 0) {
					keywordMatchGroups.push(sortKeywordsByPriority(uniqueGroup));
				}
			}
		}

		// 未分组的关键词单独成组
		for (const kw of keywordSet) {
			if (!groupedKeywordSet.has(kw)) {
				keywordMatchGroups.push([kw]);
				groupedKeywordSet.add(kw);
			}
		}

		this.pruneGuidebookFileKeywordCache(guidebookRootPath, activeGuidebookPaths);

		return {
			keywords: sortKeywordsByPriority(Array.from(keywordSet)),
			keywordMatchGroups,
			previewsByKeyword,
		};
	}

	// ========== 修改后的 resolveGuidebookFileKeywordIndex ==========
	private async resolveGuidebookFileKeywordIndex(
		filePath: string,
		mtime: number,
		size: number,
	): Promise<GuidebookFileKeywordCacheEntry> {
		const cached = this.guidebookFileKeywordCacheByPath.get(filePath);
		if (cached && cached.mtime === mtime && cached.size === size) {
			return cached;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			return this.emptyCacheEntry(mtime, size);
		}

		// 确定 guidebookRootPath
		const libraryRoot = this.resolveContainingLibraryRoot(filePath);
		if (!libraryRoot) {
			return this.emptyCacheEntry(mtime, size);
		}
		const guidebookRootPath = this.novelLibraryService.resolveNovelLibrarySubdirPath(
			libraryRoot,
			NOVEL_LIBRARY_SUBDIR_NAMES.guidebook,
		);
		if (!guidebookRootPath) {
			return this.emptyCacheEntry(mtime, size);
		}

		let entry: GuidebookFileKeywordCacheEntry;
		if (this.isPathInOtherSetting(filePath, guidebookRootPath)) {
			entry = await this.parseFileInternal(file);
		} else if (this.isPathInFolderMappedSetting(filePath, guidebookRootPath)) {
			entry = await this.parseFileAsFolderMapped(file);
		} else {
			entry = this.emptyCacheEntry(mtime, size);
		}

		this.guidebookFileKeywordCacheByPath.set(filePath, entry);
		return entry;
	}

	// ========== 原有解析逻辑抽离为 parseFileInternal ==========
	private async parseFileInternal(file: TFile): Promise<GuidebookFileKeywordCacheEntry> {
		const markdown = await this.plugin.app.vault.cachedRead(file);
		const h1List = this.guidebookMarkdownParser.parseTree(markdown);
		const settings = this.getSettings();
		const keywordSet = new Set<string>();
		const keywordMatchGroups: string[][] = [];
		const groupedKeywordSet = new Set<string>();
		const previewsByKeyword = new Map<string, GuidebookKeywordPreviewItem>();

		for (const h1Node of h1List) {
			for (const h2Node of h1Node.h2List) {
				const keyword = h2Node.title.trim();
				if (keyword.length === 0) {
					continue;
				}
				const aliases = collectGuidebookAliases({
					keyword,
					content: h2Node.content,
					enableWesternNameAutoAlias: settings.guidebookWesternNameAutoAliasEnabled,
				});
				const matchGroup = normalizeKeywordMatchGroup([keyword, ...aliases]);
				const uniqueGroup: string[] = [];
				for (const groupKeyword of matchGroup) {
					keywordSet.add(groupKeyword);
					if (!previewsByKeyword.has(groupKeyword)) {
						previewsByKeyword.set(groupKeyword, {
							keyword: groupKeyword,
							title: h2Node.title,
							categoryTitle: h1Node.title,
							content: h2Node.content,
							sourcePath: file.path,
						});
					}
					if (groupedKeywordSet.has(groupKeyword)) {
						continue;
					}
					groupedKeywordSet.add(groupKeyword);
					uniqueGroup.push(groupKeyword);
				}
				if (uniqueGroup.length > 0) {
					keywordMatchGroups.push(sortKeywordsByPriority(uniqueGroup));
				}
			}
		}

		for (const keyword of keywordSet) {
			if (!groupedKeywordSet.has(keyword)) {
				keywordMatchGroups.push([keyword]);
				groupedKeywordSet.add(keyword);
			}
		}

		return {
			mtime: file.stat.mtime,
			size: file.stat.size,
			keywords: sortKeywordsByPriority(Array.from(keywordSet)),
			keywordMatchGroups,
			previewsByKeyword,
		};
	}

	// ========== 新增解析逻辑：文件夹映射（人物/势力/地点设定） ==========
	private async parseFileAsFolderMapped(file: TFile): Promise<GuidebookFileKeywordCacheEntry> {
		const markdown = await this.plugin.app.vault.cachedRead(file);
		const settings = this.getSettings();

		// 提取分类和关键词
		const libraryRoot = this.resolveContainingLibraryRoot(file.path);
		if (!libraryRoot) {
			return this.emptyCacheEntry(file.stat.mtime, file.stat.size);
		}
		const guidebookRootPath = this.novelLibraryService.resolveNovelLibrarySubdirPath(
			libraryRoot,
			NOVEL_LIBRARY_SUBDIR_NAMES.guidebook,
		);
		if (!guidebookRootPath) {
			return this.emptyCacheEntry(file.stat.mtime, file.stat.size);
		}

		// 找到所属的设定目录
		const mappedDirs = [
			GUIDEBOOK_SUBDIR_NAMES.characterSetting,
			GUIDEBOOK_SUBDIR_NAMES.factionSetting,
			GUIDEBOOK_SUBDIR_NAMES.locationSetting,
		];
		let matchedDir: string | null = null;
		let afterDirPath = '';
		for (const dir of mappedDirs) {
			const dirPath = `${guidebookRootPath}/${dir}`;
			if (file.path.startsWith(dirPath)) {
				matchedDir = dir;
				afterDirPath = file.path.slice(dirPath.length + 1);
				break;
			}
		}
		if (!matchedDir || !afterDirPath.includes('/')) {
			// 没有子文件夹，不符合预期结构
			return this.emptyCacheEntry(file.stat.mtime, file.stat.size);
		}

		const parts = afterDirPath.split('/');
		const categoryTitle = parts[0]??""; // 子文件夹名作为 H1
		const keyword = parts.pop()?.replace(/\.md$/i, '').trim()??"";
		if (keyword.length === 0) {
			return this.emptyCacheEntry(file.stat.mtime, file.stat.size);
		}

		// 生成别名
		const aliases = collectGuidebookAliases({
			keyword,
			content: markdown,
			enableWesternNameAutoAlias: settings.guidebookWesternNameAutoAliasEnabled,
		});
		const matchGroup = normalizeKeywordMatchGroup([keyword, ...aliases]);

		const keywordSet = new Set<string>(matchGroup);
		const keywordMatchGroups: string[][] = [sortKeywordsByPriority(matchGroup)];
		const previewsByKeyword = new Map<string, GuidebookKeywordPreviewItem>();

		for (const groupKeyword of matchGroup) {
			previewsByKeyword.set(groupKeyword, {
				keyword: groupKeyword,
				title: keyword,
				categoryTitle,
				content: markdown,
				sourcePath: file.path,
			});
		}

		return {
			mtime: file.stat.mtime,
			size: file.stat.size,
			keywords: sortKeywordsByPriority(Array.from(keywordSet)),
			keywordMatchGroups,
			previewsByKeyword,
		};
	}

	// ========== 辅助方法：返回空缓存条目 ==========
	private emptyCacheEntry(mtime: number, size: number): GuidebookFileKeywordCacheEntry {
		return {
			mtime,
			size,
			keywords: [],
			keywordMatchGroups: [],
			previewsByKeyword: new Map(),
		};
	}


	private clearKeywordCache(): void {
		this.keywordCacheVersion += 1;
		this.guidebookKeywordsByLibraryRoot.clear();
		this.guidebookKeywordMatchGroupsByLibraryRoot.clear();
		this.guidebookKeywordPreviewByLibraryRoot.clear();
		this.loadingGuidebookKeywordRoots.clear();
		this.dirtyGuidebookKeywordRoots.clear();
		this.guidebookFileKeywordCacheByPath.clear();
	}

	private pruneKeywordCache(): void {
		const validLibraryRoots = new Set(this.novelLibraryService.normalizeLibraryRoots(this.getSettings().novelLibraries));
		for (const libraryRoot of this.guidebookKeywordsByLibraryRoot.keys()) {
			if (!validLibraryRoots.has(libraryRoot)) {
				this.guidebookKeywordsByLibraryRoot.delete(libraryRoot);
			}
		}
		for (const libraryRoot of this.guidebookKeywordPreviewByLibraryRoot.keys()) {
			if (!validLibraryRoots.has(libraryRoot)) {
				this.guidebookKeywordPreviewByLibraryRoot.delete(libraryRoot);
			}
		}
		for (const libraryRoot of this.guidebookKeywordMatchGroupsByLibraryRoot.keys()) {
			if (!validLibraryRoots.has(libraryRoot)) {
				this.guidebookKeywordMatchGroupsByLibraryRoot.delete(libraryRoot);
			}
		}
		for (const libraryRoot of this.dirtyGuidebookKeywordRoots) {
			if (!validLibraryRoots.has(libraryRoot)) {
				this.dirtyGuidebookKeywordRoots.delete(libraryRoot);
			}
		}
	}

	private resolveContainingLibraryRoot(filePath: string | null): string | null {
		if (!filePath) {
			return null;
		}
		const settings = this.getSettings();
		const normalizedLibraryRoots = this.novelLibraryService.normalizeLibraryRoots(settings.novelLibraries);
		return this.novelLibraryService.resolveContainingLibraryRoot(filePath, normalizedLibraryRoots);
	}

	private isGuidebookPath(path: string | null): boolean {
		if (!path) {
			return false;
		}
		const normalizedPath = this.novelLibraryService.normalizeVaultPath(path);
		if (!normalizedPath) {
			return false;
		}
		return this.resolveGuidebookRoots().some((root) => this.novelLibraryService.isSameOrChildPath(normalizedPath, root));
	}

	private resolveGuidebookRoots(): string[] {
		const settings = this.getSettings();
		return settings.novelLibraries
			.map((libraryPath) =>
				this.novelLibraryService.resolveNovelLibrarySubdirPath(libraryPath,
					NOVEL_LIBRARY_SUBDIR_NAMES.guidebook,
				),
			)
			.filter((path) => path.length > 0);
	}

	private applyStyles(): void {
		const rootEl = this.getRootEl();
		const settings = this.getSettings();
		const underlineEnabled = settings.guidebookKeywordUnderlineStyle !== "none";
		rootEl.style.setProperty(
			GUIDEBOOK_KEYWORD_BACKGROUND_VAR,
			this.normalizeCssColor(settings.guidebookKeywordHighlightBackgroundColor, "transparent"),
		);
		rootEl.style.setProperty(
			GUIDEBOOK_KEYWORD_UNDERLINE_STYLE_VAR,
			underlineEnabled ? settings.guidebookKeywordUnderlineStyle : "none",
		);
		rootEl.style.setProperty(
			GUIDEBOOK_KEYWORD_UNDERLINE_WIDTH_VAR,
			`${this.normalizeBorderWidth(settings.guidebookKeywordUnderlineStyle, settings.guidebookKeywordUnderlineWidth)}px`,
		);
		rootEl.style.setProperty(
			GUIDEBOOK_KEYWORD_UNDERLINE_COLOR_VAR,
			this.normalizeCssColor(settings.guidebookKeywordUnderlineColor, "currentColor"),
		);
		rootEl.style.setProperty(GUIDEBOOK_KEYWORD_FONT_WEIGHT_VAR, settings.guidebookKeywordFontWeight);
		rootEl.style.setProperty(GUIDEBOOK_KEYWORD_FONT_STYLE_VAR, settings.guidebookKeywordFontStyle);
		rootEl.style.setProperty(
			GUIDEBOOK_KEYWORD_TEXT_COLOR_VAR,
			this.normalizeCssColor(settings.guidebookKeywordTextColor, "inherit"),
		);
	}

	private clearStyles(): void {
		const rootEl = this.getRootEl();
		rootEl.style.removeProperty(GUIDEBOOK_KEYWORD_BACKGROUND_VAR);
		rootEl.style.removeProperty(GUIDEBOOK_KEYWORD_UNDERLINE_STYLE_VAR);
		rootEl.style.removeProperty(GUIDEBOOK_KEYWORD_UNDERLINE_WIDTH_VAR);
		rootEl.style.removeProperty(GUIDEBOOK_KEYWORD_UNDERLINE_COLOR_VAR);
		rootEl.style.removeProperty(GUIDEBOOK_KEYWORD_FONT_WEIGHT_VAR);
		rootEl.style.removeProperty(GUIDEBOOK_KEYWORD_FONT_STYLE_VAR);
		rootEl.style.removeProperty(GUIDEBOOK_KEYWORD_TEXT_COLOR_VAR);
	}

	private normalizeCssColor(value: string, fallback: string): string {
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : fallback;
	}

	private normalizeBorderWidth(style: SettingDatas["guidebookKeywordUnderlineStyle"], width: number): number {
		const normalizedWidth = Math.max(0, Math.min(10, Math.round(width)));
		return style === "double" ? Math.max(3, normalizedWidth) : normalizedWidth;
	}

	/**
	 * 清理指南文件关键词缓存
	 * 
	 * 遍历当前缓存中的所有路径，仅保留与指定根目录相关且仍处于活动状态的指南文件。
	 * 
	 * @param guidebookRootPath - 指南库的根目录路径，用于限定清理范围
	 * @param activeGuidebookPaths - 当前有效的指南文件路径集合（通常来自文件系统扫描或配置）
	 * 
	 * @remarks
	 * 该方法会执行以下过滤逻辑：
	 * 1. 跳过所有不在 `guidebookRootPath` 目录下的缓存条目（包括子目录）
	 * 2. 对于在根目录下的条目，仅当路径存在于 `activeGuidebookPaths` 中时才保留，否则删除
	 * 
	 * 最终缓存中仅剩根目录下仍有效的指南文件关键词数据。
	 */
	private pruneGuidebookFileKeywordCache(guidebookRootPath: string, activeGuidebookPaths: Set<string>): void {
		for (const path of this.guidebookFileKeywordCacheByPath.keys()) {
			if (!this.novelLibraryService.isSameOrChildPath(path, guidebookRootPath)) {
				continue;
			}
			if (!activeGuidebookPaths.has(path)) {
				this.guidebookFileKeywordCacheByPath.delete(path);
			}
		}
	}

	private getRootEl(): HTMLElement {
		const workspaceContainerEl = (this.plugin.app.workspace as unknown as { containerEl?: HTMLElement }).containerEl;
		return workspaceContainerEl ?? document.body;
	}
}

export function createGuidebookKeywordRules(
	getSettings: () => SettingDatas,
	getKeywordsByView: (view: EditorView) => readonly string[],
	getKeywordMatchGroupsByView: (view: EditorView) => readonly (readonly string[])[],
	shouldDetectInView?: (view: EditorView) => boolean,
): TextDetectionRule[] {
	let cachedSourceKeywords: readonly string[] | null = null;
	let cachedNormalizedKeywords: readonly string[] = [];
	let cachedSourceKeywordGroups: readonly (readonly string[])[] | null = null;
	let cachedNormalizedKeywordGroups: readonly (readonly string[])[] = [];

	return [
		{
			className: GUIDEBOOK_KEYWORD_HIT_CLASS,
			isEnabled: (view) => {
				if (shouldDetectInView && !shouldDetectInView(view)) {
					return false;
				}
				return getNormalizedKeywordsByView(view).length > 0;
			},
			matchDocumentRanges: (docText, view): TextDetectionRange[] => {
				const settings = getSettings();
				const keywords = getNormalizedKeywordsByView(view);
				const keywordGroups = getNormalizedKeywordGroupsByView(view);
				if (docText.length === 0 || keywords.length === 0) {
					return [];
				}

				const ranges =
					settings.guidebookKeywordHighlightMode === "all"
						? collectAllMatchRanges(docText, keywords)
						: collectFirstMatchRangesByGroup(docText, keywordGroups);
				if (ranges.length === 0) {
					return [];
				}
				return ranges;
			},
		},
	];

	function getNormalizedKeywordsByView(view: EditorView): readonly string[] {
		const keywords = getKeywordsByView(view);
		if (keywords === cachedSourceKeywords) {
			return cachedNormalizedKeywords;
		}
		cachedSourceKeywords = keywords;
		cachedNormalizedKeywords = normalizeKeywords(keywords);
		cachedSourceKeywordGroups = null;
		return cachedNormalizedKeywords;
	}

	function getNormalizedKeywordGroupsByView(view: EditorView): readonly (readonly string[])[] {
		const keywordGroups = getKeywordMatchGroupsByView(view);
		if (keywordGroups === cachedSourceKeywordGroups) {
			return cachedNormalizedKeywordGroups;
		}
		cachedSourceKeywordGroups = keywordGroups;
		cachedNormalizedKeywordGroups = normalizeKeywordGroups(keywordGroups, getNormalizedKeywordsByView(view));
		return cachedNormalizedKeywordGroups;
	}
}

function normalizeKeywords(keywords: readonly string[]): string[] {
	const deduped = new Set<string>();
	for (const keyword of keywords) {
		const normalized = keyword.trim();
		if (normalized.length === 0) {
			continue;
		}
		deduped.add(normalized);
	}
	return Array.from(deduped).sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function collectFirstMatchRangesByGroup(docText: string, keywordGroups: readonly (readonly string[])[]): MatchRange[] {
	const ranges: MatchRange[] = [];
	for (const group of keywordGroups) {
		let firstIndex = -1;
		let firstKeyword = "";
		for (const keyword of group) {
			const matchIndex = docText.indexOf(keyword);
			if (matchIndex < 0) {
				continue;
			}
			if (
				firstIndex < 0 ||
				matchIndex < firstIndex ||
				(matchIndex === firstIndex && keyword.length > firstKeyword.length) ||
				(matchIndex === firstIndex && keyword.length === firstKeyword.length && keyword.localeCompare(firstKeyword) < 0)
			) {
				firstIndex = matchIndex;
				firstKeyword = keyword;
			}
		}
		if (firstIndex < 0 || firstKeyword.length === 0) {
			continue;
		}
		ranges.push({
			from: firstIndex,
			to: firstIndex + firstKeyword.length,
		});
	}
	return ranges;
}

function collectAllMatchRanges(docText: string, keywords: readonly string[]): MatchRange[] {
	const ranges: MatchRange[] = [];
	for (const keyword of keywords) {
		let cursor = 0;
		while (cursor < docText.length) {
			const matchIndex = docText.indexOf(keyword, cursor);
			if (matchIndex < 0) {
				break;
			}
			ranges.push({
				from: matchIndex,
				to: matchIndex + keyword.length,
			});
			cursor = matchIndex + keyword.length;
		}
	}
	return ranges;
}

function areKeywordListsEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (left[i] !== right[i]) {
			return false;
		}
	}
	return true;
}

function areKeywordMatchGroupsEqual(
	left: readonly (readonly string[])[],
	right: readonly (readonly string[])[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		const leftGroup = left[i] ?? [];
		const rightGroup = right[i] ?? [];
		if (leftGroup.length !== rightGroup.length) {
			return false;
		}
		for (let j = 0; j < leftGroup.length; j += 1) {
			if (leftGroup[j] !== rightGroup[j]) {
				return false;
			}
		}
	}
	return true;
}

function normalizeKeywordGroups(
	keywordGroups: readonly (readonly string[])[],
	fallbackKeywords: readonly string[],
): string[][] {
	const groupedKeywords = new Set<string>();
	const normalizedGroups: string[][] = [];
	for (const group of keywordGroups) {
		const normalizedGroup = normalizeKeywordMatchGroup(group);
		const uniqueGroup: string[] = [];
		for (const keyword of normalizedGroup) {
			if (groupedKeywords.has(keyword)) {
				continue;
			}
			groupedKeywords.add(keyword);
			uniqueGroup.push(keyword);
		}
		if (uniqueGroup.length > 0) {
			normalizedGroups.push(uniqueGroup);
		}
	}
	for (const keyword of normalizeKeywords(fallbackKeywords)) {
		if (groupedKeywords.has(keyword)) {
			continue;
		}
		groupedKeywords.add(keyword);
		normalizedGroups.push([keyword]);
	}
	return normalizedGroups;
}

function normalizeKeywordMatchGroup(keywords: readonly string[]): string[] {
	return sortKeywordsByPriority(normalizeKeywords(keywords));
}

function sortKeywordsByPriority(keywords: readonly string[]): string[] {
	return [...keywords].sort((left, right) => right.length - left.length || left.localeCompare(right));
}






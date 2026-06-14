import { App, FileManager, TFolder } from "obsidian";
import type { SettingDatas } from "./setting-datas";
import characterTemplate from "../../resources/templates/characterTemplate.md";
import factionTemplate from "../../resources/templates/factionTemplate.md";
import changeTemplate from "../../resources/templates/changeTemplate.md";
import locationTemplate from "../../resources/templates/locationTemplate.md";
import snippetTemplate from "../../resources/templates/snippetTemplate.md";
import chapterTemplate from "../../resources/templates/chapterTemplate.md";
import correctionTemplate from "../../resources/templates/correctionTemplate.md";
import settingTemplate from "../../resources/templates/settingTemplate.md";
import PROJECT_OVERVIEW from "../../resources/templates/projectOverview.md";

const NOVEL_LIBRARY_FEATURE_DIR_NAME = "_功能库";

export const NOVEL_LIBRARY_SUBDIR_NAMES = {
	guidebook: "设定库",
	stickyNote: "便签库",
	annotation: "批注库",
	timeline: "时间轴库",
	snippet: "片段库",
	proofreadDictionary: "纠错词库",
	templeLibrary: "模板库",
	changeRecord: "变动记录",
} as const;

const GUIDEBOOK_SUBDIR_NAMES = ["人物设定", "势力设定", "地点设定", "其他设定"];
type NovelLibrarySubdirKey = keyof typeof NOVEL_LIBRARY_SUBDIR_NAMES;
const NOVEL_LIBRARY_SUBDIR_KEYS = Object.keys(NOVEL_LIBRARY_SUBDIR_NAMES) as NovelLibrarySubdirKey[];
const TEMPLATES = [
	{
		fileName: "人物模板",
		content: characterTemplate
	}, {
		fileName: "势力模板",
		content: factionTemplate
	}, {
		fileName: "变动模板",
		content: changeTemplate
	}, {
		fileName: "地点模板",
		content: locationTemplate
	}, {
		fileName: "片段模板",
		content: snippetTemplate
	}, {
		fileName: "章节模板",
		content: chapterTemplate
	}, {
		fileName: "纠错模板",
		content: correctionTemplate
	}, {
		fileName: "设定模板",
		content: settingTemplate
	}
];
const PROJECT_OVERVIEW_NAME = "项目总览";

export function normalizeVaultPath(value: string): string {
	return value
		.trim()				 //去除头尾空白
		.replace(/\\/g, "/") //替换反斜杠
		.replace(/^\/+/, "") //去除开始的'/'
		.replace(/\/+$/, "");//去除结尾'/'
}

export function normalizeFileName(filename: string): string {
	const trimmed = filename.trim();
	if (trimmed.length === 0) {
		throw new Error("Filename cannot be empty");
	}
	const normalized = trimmed.replace(/[\\/:*?"<>|]/g, '-');
	return normalized;
}

export class NovelLibraryService {
	private app: App;
	constructor(app: App) {
		this.app = app;
	}

	private normalizeNovelLibrary(value: string): string {
		return value.trim().toLowerCase();
	}

	hasNovelLibrary(novelLibraries: string[], value: string): boolean {
		const normalizedValue = this.normalizeNovelLibrary(value);
		return novelLibraries.some((item) => this.normalizeNovelLibrary(item) === normalizedValue);
	}

	normalizeVaultPath(value: string): string {
		return normalizeVaultPath(value);
	}

	normalizeFileName(value: string): string {
		return normalizeFileName(value);
	}

	normalizeLibraryRoots(libraryPaths: string[]): string[] {
		return Array.from(
			new Set(
				libraryPaths
					.map((path) => this.normalizeVaultPath(path))
					.filter((path) => path.length > 0),
			),
		).sort((left, right) => right.length - left.length);
	}

	isSameOrChildPath(path: string, root: string): boolean {
		const normalizedPath = this.normalizeVaultPath(path);
		const normalizedRoot = this.normalizeVaultPath(root);
		if (!normalizedPath || !normalizedRoot) {
			return false;
		}
		return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
	}

	resolveContainingLibraryRoot(path: string, libraryRoots: string[]): string | null {
		const normalizedPath = this.normalizeVaultPath(path);
		if (!normalizedPath) {
			return null;
		}

		const normalizedRoots = this.normalizeLibraryRoots(libraryRoots);
		for (const root of normalizedRoots) {
			if (this.isSameOrChildPath(normalizedPath, root)) {
				return root;
			}
		}
		return null;
	}

	isPathInLibraries(path: string, libraryRoots: string[]): boolean {
		return this.resolveContainingLibraryRoot(path, libraryRoots) !== null;
	}

	isInFeatureRoot(path: string, settings: Pick<SettingDatas, "locale" | "novelLibraries">): boolean {
		const libraryRoot = this.resolveContainingLibraryRoot(path, settings.novelLibraries);
		if (!libraryRoot) {
			return false;
		}

		const featureRoot = this.resolveNovelLibraryFeatureRootPath(libraryRoot);
		if (!featureRoot) {
			return false;
		}

		return this.isSameOrChildPath(path, featureRoot);
	}

	resolveNovelLibrarySubdirPaths(libraryPath: string): string[] {
		const normalizedLibraryPath = this.normalizeVaultPath(libraryPath);
		if (!normalizedLibraryPath) {
			return [];
		}
		const featureRootPath = this.resolveFeatureRootPath(normalizedLibraryPath);
		if (!featureRootPath) {
			return [];
		}

		return NOVEL_LIBRARY_SUBDIR_KEYS
			.map((subdirKey) => this.normalizeVaultPath(`${featureRootPath}/${NOVEL_LIBRARY_SUBDIR_NAMES[subdirKey]}`))
			.filter((path) => path.length > 0);
	}

	/**
	 * 解析小说库中子目录的完整路径。
	 *
	 * 该函数用于规范化传入的库路径和子目录名称，解析出对应的功能根路径，
	 * 并根据子目录名称的解析结果，拼接出最终的子目录完整路径。
	 * 如果任一规范化路径无效，或功能根路径解析失败，则返回空字符串。
	 *
	 * @param libraryPath - 小说库的基础路径，将首先被规范化。
	 * @param subdirName  - 子目录的名称，将先被规范化，然后进一步解析为有效的子目录名。
	 * @returns 规范化后的完整子目录路径；若中间步骤失败则返回空字符串。
	 */
	resolveNovelLibrarySubdirPath(
		libraryPath: string,
		subdirName: string,
	): string {
		const normalizedLibraryPath = this.normalizeVaultPath(libraryPath);
		const normalizedSubdirName = this.normalizeVaultPath(subdirName);
		if (!normalizedLibraryPath || !normalizedSubdirName) {
			return "";
		}
		const featureRootPath = this.resolveFeatureRootPath(normalizedLibraryPath);
		if (!featureRootPath) {
			return "";
		}

		const resolvedSubdirName = this.resolveSubdirName(normalizedSubdirName);
		return this.normalizeVaultPath(`${featureRootPath}/${resolvedSubdirName}`);
	}

	resolveNovelLibraryFeatureRootPath(libraryPath: string): string {
		const normalizedLibraryPath = this.normalizeVaultPath(libraryPath);
		if (!normalizedLibraryPath) {
			return "";
		}
		return this.resolveFeatureRootPath(normalizedLibraryPath);
	}

	async ensureNovelLibraryStructure(libraryPath: string): Promise<void> {
		const normalizedLibraryPath = this.normalizeVaultPath(libraryPath);
		if (!normalizedLibraryPath) {
			return;
		}
		await this.ensureFolderPath(normalizedLibraryPath);

		const featureRootPath = this.resolveFeatureRootPath(normalizedLibraryPath);
		if (!featureRootPath) {
			return;
		}
		await this.ensureFolderPath(featureRootPath);

		for (const subdirKey of NOVEL_LIBRARY_SUBDIR_KEYS) {
			await this.ensureFolderPath(
				this.normalizeVaultPath(`${featureRootPath}/${NOVEL_LIBRARY_SUBDIR_NAMES[subdirKey]}`),
			);
		}
		await this.ensureGuidebookSubfolders(featureRootPath);
		await this.ensureTemplateLibTemplates(featureRootPath);
		await this.ensureMarkdownFile(featureRootPath, PROJECT_OVERVIEW_NAME, PROJECT_OVERVIEW);
	}

	private async ensureGuidebookSubfolders(featureRootPath: string): Promise<void> {
		const guidebookRootPath = this.normalizeVaultPath(`${featureRootPath}/${NOVEL_LIBRARY_SUBDIR_NAMES.guidebook}`);
		if (!guidebookRootPath) {
			return;
		}
		for (const gudieSubName of GUIDEBOOK_SUBDIR_NAMES) {
			await this.ensureFolderPath(
				this.normalizeVaultPath(`${guidebookRootPath}/${gudieSubName}`),
			);
		}
	}

	private async ensureTemplateLibTemplates(featureRootPath: string): Promise<void> {
		const templateLibPath = this.normalizeVaultPath(`${featureRootPath}/${NOVEL_LIBRARY_SUBDIR_NAMES.templeLibrary}`);
		if (!templateLibPath) {
			return;
		}
		for (const { fileName, content } of TEMPLATES) {
			await this.ensureMarkdownFile(
				templateLibPath, fileName, content
			);
		}
	};

	private resolveFeatureRootPath(normalizedLibraryPath: string): string {
		if (!normalizedLibraryPath) {
			return "";
		}
		return this.normalizeVaultPath(`${normalizedLibraryPath}/${NOVEL_LIBRARY_FEATURE_DIR_NAME}`);
	}

	private resolveSubdirName(subdirName: string): string {
		const normalizedInput = this.normalizeVaultPath(subdirName);
		const normalizedInputLower = normalizedInput.toLowerCase();
		if (!normalizedInputLower) {
			return "";
		}

		for (const subdirKey of NOVEL_LIBRARY_SUBDIR_KEYS) {
			if (normalizedInputLower === subdirKey.toLowerCase()) {
				return NOVEL_LIBRARY_SUBDIR_NAMES[subdirKey];
			}
		}
		return normalizedInput;
	}

	async ensureFolderPath(path: string): Promise<void> {
		const normalizedPath = this.normalizeVaultPath(path);
		if (!normalizedPath) {
			return;
		}

		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
		let currentPath = "";
		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				await this.app.vault.createFolder(currentPath);
				continue;
			}

			if (!(existing instanceof TFolder)) {
				throw new Error(`Path already exists as file: ${currentPath}`);
			}
		}
	}

	async ensureMarkdownFile(rootPath: string, filename: string, content: string): Promise<void> {
		const normalizedDir = this.normalizeVaultPath(rootPath);
		const normalizedFile = this.normalizeFileName(filename);
		const fullPath = `${normalizedDir}/${normalizedFile}.md`;

		const dirFile = this.app.vault.getAbstractFileByPath(normalizedDir);
		if (!dirFile) {
			await this.app.vault.createFolder(normalizedDir);
		}
		const existing = this.app.vault.getAbstractFileByPath(fullPath);
		if (!existing) {
			await this.app.vault.create(fullPath, content);
		}
	}
}


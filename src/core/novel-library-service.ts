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
const NOVEL_LIBRARY_MAIN_BODY = "正文";
const PROJECT_OVERVIEW_NAME = "项目总览";

export const NOVEL_LIBRARY_SUBDIR_NAMES = {
	guidebook: "设定库",
	stickyNote: "便签库",
	annotation: "批注库",
	timeline: "时间轴库",
	snippet: "片段库",
	proofreadDictionary: "纠错词库",
	templeLibrary: "模板库",
	changeRecord: "变动记录",
	mapLibrary: "地图库"
} as const;

export const GUIDEBOOK_SUBDIR_NAMES = {
	characterSetting: "人物设定",
	factionSetting: "势力设定",
	locationSetting: "地点设定",
	otherSetting: "其他设定"
} as const;

type NovelLibrarySubdirKey = keyof typeof NOVEL_LIBRARY_SUBDIR_NAMES;
type GuidebookSubdirKey = keyof typeof GUIDEBOOK_SUBDIR_NAMES;
const NOVEL_LIBRARY_SUBDIR_KEYS = Object.keys(NOVEL_LIBRARY_SUBDIR_NAMES) as NovelLibrarySubdirKey[];
const GUIDEBOOK_SUBDIR_KEYS = Object.keys(GUIDEBOOK_SUBDIR_NAMES) as GuidebookSubdirKey[];

const TEMPLATES = [
	{ fileName: "人物模板", content: characterTemplate },
	{ fileName: "势力模板", content: factionTemplate },
	{ fileName: "变动模板", content: changeTemplate },
	{ fileName: "地点模板", content: locationTemplate },
	{ fileName: "片段模板", content: snippetTemplate },
	{ fileName: "章节模板", content: chapterTemplate },
	{ fileName: "纠错模板", content: correctionTemplate },
	{ fileName: "设定模板", content: settingTemplate },
];

// ==================== 公共工具函数 ====================
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
	return trimmed.replace(/[\\/:*?"<>|]/g, '-');
}

/**
 * 小说库核心服务，负责库路径解析、目录结构创建、文件管理等操作。
 */
export class NovelLibraryService {
	private app: App;
	constructor(app: App) {
		this.app = app;
	}

	/**
	 * 规范化小说库名称（用于比较匹配）。
	 * @param value - 原始库名
	 * @returns 小写且去除首尾空格的字符串
	 */
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

	/**
	 * 规范化并去重排序库根路径列表（按路径长度降序，便于子路径匹配）。
	 * @param libraryPaths - 原始库路径数组
	 * @returns 规范化后的唯一路径数组，按长度从长到短排序
	 */
	normalizeLibraryRoots(libraryPaths: string[]): string[] {
		return Array.from(
			new Set(
				libraryPaths
					.map((path) => this.normalizeVaultPath(path))
					.filter((path) => path.length > 0),
			),
		).sort((left, right) => right.length - left.length);
	}

	/**
	 * 判断目标路径是否与根路径相同或是其子路径（基于目录层级）。
	 * @param path - 待判断的路径
	 * @param root - 根路径
	 * @returns 若为相同或子路径则返回 true
	 */
	isSameOrChildPath(path: string, root: string): boolean {
		const normalizedPath = this.normalizeVaultPath(path);
		const normalizedRoot = this.normalizeVaultPath(root);
		if (!normalizedPath || !normalizedRoot) {
			return false;
		}
		return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
	}

	/**
	 * 解析给定路径所属的小说库根路径。
	 * @param path - 仓库内任意路径
	 * @param libraryRoots - 所有已配置的小说库根路径列表
	 * @returns 匹配的库根路径，若不属于任何库则返回 null
	 */
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

	/**
	 * 判断某路径是否位于任何已配置的小说库内。
	 * @param path - 待检测路径
	 * @param libraryRoots - 库根路径列表
	 */
	isPathInLibraries(path: string, libraryRoots: string[]): boolean {
		return this.resolveContainingLibraryRoot(path, libraryRoots) !== null;
	}

	/**
	 * 判断路径是否位于其所属小说库的“功能库”目录内。
	 * @param path - 待检测路径
	 * @param settings - 包含 locale 和 novelLibraries 的配置对象
	 */
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

	/**
	 * 获取小说库功能库下所有预定义子目录的完整路径（设定库、便签库等）。
	 * @param libraryPath - 小说库根路径
	 * @returns 子目录路径数组（可能为空）
	 */
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

	/**
	 * 获取小说库的“功能库”根目录路径。
	 * @param libraryPath - 小说库根路径
	 * @returns 功能库路径，例如 "某库/_功能库"
	 */
	resolveNovelLibraryFeatureRootPath(libraryPath: string): string {
		const normalizedLibraryPath = this.normalizeVaultPath(libraryPath);
		if (!normalizedLibraryPath) {
			return "";
		}
		return this.resolveFeatureRootPath(normalizedLibraryPath);
	}

	/**
	 * 确保小说库的完整目录结构存在（包括正文、功能库、各子库及模板文件）。
	 * 若目录或文件已存在则跳过创建。
	 * @param libraryPath - 小说库根路径
	 */
	async ensureNovelLibraryStructure(libraryPath: string): Promise<void> {
		//小说库根目录
		const normalizedLibraryPath = this.normalizeVaultPath(libraryPath);
		if (!normalizedLibraryPath) {
			return;
		}
		await this.ensureFolderPath(normalizedLibraryPath);

		//根目录下的 _功能库 文件夹
		const featureRootPath = this.resolveFeatureRootPath(normalizedLibraryPath);
		if (!featureRootPath) {
			return;
		}
		await this.ensureFolderPath(featureRootPath);

		//根目录下的 正文 文件夹
		const mainBodyPath = this.normalizeVaultPath(`${normalizedLibraryPath}/${NOVEL_LIBRARY_MAIN_BODY}`);
		if (mainBodyPath) {
			await this.ensureFolderPath(mainBodyPath);
		}

		//_功能库 下的所有子目录（设定库、便签库、批注库…）
		for (const subdirKey of NOVEL_LIBRARY_SUBDIR_KEYS) {
			await this.ensureFolderPath(
				this.normalizeVaultPath(`${featureRootPath}/${NOVEL_LIBRARY_SUBDIR_NAMES[subdirKey]}`),
			);
		}
		//设定库下的二级子目录（人物设定、势力设定、地点设定、其他设定）
		await this.ensureGuidebookSubfolders(featureRootPath);
		//模板库中预置的 8 个模板文件（如果不存在则创建）
		await this.ensureTemplateLibTemplates(featureRootPath);
		//项目总览笔记（项目总览.md）
		await this.ensureMarkdownFile(normalizedLibraryPath, PROJECT_OVERVIEW_NAME, PROJECT_OVERVIEW);
	}

	private async ensureGuidebookSubfolders(featureRootPath: string): Promise<void> {
		const guidebookRootPath = this.normalizeVaultPath(`${featureRootPath}/${NOVEL_LIBRARY_SUBDIR_NAMES.guidebook}`);
		if (!guidebookRootPath) {
			return;
		}
		for (const guidebookSubdirKey of GUIDEBOOK_SUBDIR_KEYS) {
			await this.ensureFolderPath(
				this.normalizeVaultPath(`${guidebookRootPath}/${GUIDEBOOK_SUBDIR_NAMES[guidebookSubdirKey]}`),
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

	/**
	 * 根据规范化的小说库根路径拼接“_功能库”路径。
	 * @param normalizedLibraryPath - 已规范化的库根路径
	 * @returns 功能库完整路径
	 */
	private resolveFeatureRootPath(normalizedLibraryPath: string): string {
		if (!normalizedLibraryPath) {
			return "";
		}
		return this.normalizeVaultPath(`${normalizedLibraryPath}/${NOVEL_LIBRARY_FEATURE_DIR_NAME}`);
	}

	/**
	 * 将用户输入的子目录名解析为实际存储时使用的目录名。
	 * 支持预定义 key 的别名匹配（大小写不敏感）。
	 * @param subdirName - 原始子目录名
	 * @returns 实际目录名（若未匹配则返回原输入）
	  */
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

	/**
	 * 递归创建文件夹路径（若部分已存在则跳过，遇到文件冲突则抛出异常）。
	 * @param path - 目标文件夹路径
	 * @throws 当路径中存在与文件夹同名的文件时抛出错误
	 */
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

	/**
	 * 确保指定目录下存在某个 Markdown 文件，若不存在则用给定内容创建。
	 * @param rootPath - 所在文件夹路径
	 * @param filename - 文件名（不含扩展名）
	 * @param content - 文件初始内容
	 */
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


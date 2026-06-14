import { App, TFile, TFolder } from "obsidian";
import { NovelLibraryService, NOVEL_LIBRARY_SUBDIR_NAMES, listMarkdownFilesInFolder, type SettingDatas } from "../../core";
import { GuidebookMarkdownParser } from "./markdown-parser";
import { logger } from "../../utils/logger";

// ============ 常量与类型定义 ============
export const SPECIAL_FOLDERS = ['人物设定', '势力设定', '地点设定'];

export interface GuidebookTreeH2Node {
	title: string;
	content: string;
	sourcePath: string;
	sourceFileCtime: number;
	sourceFileMtime: number;
	h1IndexInSource: number;
	h2IndexInH1: number;
	isSpecific: boolean;
}

export interface GuidebookTreeH1Node {
	title: string;
	h2List: GuidebookTreeH2Node[];
	sourcePath: string;
	sourceFileCtime: number;
	sourceFileMtime: number;
	h1IndexInSource: number;
	isSpecific: boolean;
}

export interface GuidebookTreeFileNode {
	fileName: string;
	stableKey: string;
	sourcePaths: string[];
	h1List: GuidebookTreeH1Node[];
	h2Count: number;
	isSpecific: boolean;
}

export interface GuidebookTreeData {
	libraryRootPath: string;
	guidebookRootPath: string;
	files: GuidebookTreeFileNode[];
}

type GuidebookTreeBuildSettings = Pick<
	SettingDatas,
	"locale" | "novelLibraries" | "guidebookCollectionOrders"
>;

interface GuidebookTreeFileBucket extends GuidebookTreeFileNode {
	firstFileCtime: number;
}

interface ParsedGuidebookFileCacheEntry {
	mtime: number;
	size: number;
	ctime: number;
	h1List: GuidebookTreeH1Node[];
}

interface GuidebookTreeCacheEntry {
	signature: string;
	orderedSourcePathsKey: string;
	data: GuidebookTreeData;
}

// ============ 全局解析器与缓存 ============
const guidebookMarkdownParser = new GuidebookMarkdownParser();
const parsedGuidebookFileCacheByPath = new Map<string, ParsedGuidebookFileCacheEntry>();
const guidebookTreeCacheByRootPath = new Map<string, GuidebookTreeCacheEntry>();

// ============ 辅助函数：文件/文件夹操作 ============
function listSubfolders(app: App, folderPath: string): TFolder[] {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!folder || !(folder instanceof TFolder)) return [];
	//TypeScript 类型守卫,只保留 folder.children 中那些是 TFolder 实例的元素
	return folder.children.filter((child): child is TFolder => child instanceof TFolder);
}

async function getFolderStatsByPath(app: App, folderPath: string): Promise<{ ctime: number; mtime: number } | null> {
	try {
		const stat = await app.vault.adapter.stat(folderPath);
		if (stat && stat.type === 'folder') {
			return { ctime: stat.ctime, mtime: stat.mtime };
		}
	} catch (error) {
		console.error(`Failed to get stats for folder: ${folderPath}`, error);
	}
	return null;
}

async function getFolderStats(app: App, folder: TFolder): Promise<{ ctime: number; mtime: number }> {
	const stats = await getFolderStatsByPath(app, folder.path);
	return stats ?? { ctime: 0, mtime: 0 };
}

function listDirectMarkdownFilesInFolder(app: App, folderPath: string): TFile[] {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!folder || !(folder instanceof TFolder)) return [];
	return folder.children.filter((child): child is TFile =>
		child instanceof TFile && child.extension === 'md'
	);
}

function compareByFileCreationTime(left: TFile, right: TFile): number {
	const ctimeDiff = left.stat.ctime - right.stat.ctime;
	if (ctimeDiff !== 0) {
		return ctimeDiff;
	}
	return left.path.localeCompare(right.path);
}

// ============ 辅助函数：Markdown 解析与缓存 ============
function mapParsedGuidebookTree(
	content: string,
	sourcePath: string,
	sourceFileCtime: number,
	sourceFileMtime: number,
): GuidebookTreeH1Node[] {
	return guidebookMarkdownParser.parseTree(content).map((h1Node) => ({
		title: h1Node.title,
		h2List: h1Node.h2List.map((h2Node): GuidebookTreeH2Node => ({
			title: h2Node.title,
			content: h2Node.content,
			sourcePath,
			sourceFileCtime,
			sourceFileMtime,
			h1IndexInSource: h2Node.h1IndexInSource,
			h2IndexInH1: h2Node.h2IndexInH1,
			isSpecific: false
		})),
		sourcePath,
		sourceFileCtime,
		sourceFileMtime,
		h1IndexInSource: h1Node.h1IndexInSource,
		isSpecific: false
	}));
}

async function resolveParsedGuidebookTreeByFile(app: App, file: TFile): Promise<GuidebookTreeH1Node[]> {
	const cached = parsedGuidebookFileCacheByPath.get(file.path);
	if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size && cached.ctime === file.stat.ctime) {
		return cached.h1List;
	}
	const markdown = await app.vault.cachedRead(file);
	const h1List = mapParsedGuidebookTree(markdown, file.path, file.stat.ctime, file.stat.mtime);
	parsedGuidebookFileCacheByPath.set(file.path, {
		mtime: file.stat.mtime,
		size: file.stat.size,
		ctime: file.stat.ctime,
		h1List,
	});
	return h1List;
}

function pruneGuidebookFileParseCache(guidebookRootPath: string, activeGuidebookPaths: Set<string>): void {
	for (const path of parsedGuidebookFileCacheByPath.keys()) {
		if (!path.startsWith(`${guidebookRootPath}/`) && path !== guidebookRootPath) {
			continue;
		}
		if (!activeGuidebookPaths.has(path)) {
			parsedGuidebookFileCacheByPath.delete(path);
		}
	}
}

// ============ 模块1：处理“其他设定”目录（通用 Markdown 文件） ============
/**
 * 处理“其他设定”目录下的所有 Markdown 文件。
 * - 扫描 guidebookRootPath/其他设定 下的所有 .md 文件（递归）。
 * - 按文件名（basename）合并多个文件（例如同名文件的不同版本），取最早创建时间作为稳定标识。
 * - 解析每个文件的 H1/H2 结构，构建 GuidebookTreeH1Node 列表。
 * - 返回 GuidebookTreeFileNode 数组，每个节点对应一个合并后的文件名。
 * 
 * @param app Obsidian App 实例
 * @param guidebookRootPath 设定库根目录路径
 * @returns 处理得到的文件节点数组
 */
async function processOtherSettingsFolder(app: App, guidebookRootPath: string): Promise<GuidebookTreeFileNode[]> {
	const otherSettingsPath = `${guidebookRootPath}/其他设定`;
	const othersMarkdownFiles = listMarkdownFilesInFolder(app, otherSettingsPath).sort(compareByFileCreationTime);
	if (othersMarkdownFiles.length === 0) return [];

	const fileBucketByName = new Map<string, GuidebookTreeFileBucket>();
	const activeFilePaths = new Set<string>();

	for (const file of othersMarkdownFiles) {
		activeFilePaths.add(file.path);
		const h1List = await resolveParsedGuidebookTreeByFile(app, file);
		const fileNameKey = file.basename;
		let bucket = fileBucketByName.get(fileNameKey);
		if (!bucket) {
			bucket = {
				fileName: file.basename,
				stableKey: String(file.stat.ctime),
				sourcePaths: [],
				h1List: [],
				h2Count: 0,
				firstFileCtime: file.stat.ctime,
				isSpecific: false,
			};
			fileBucketByName.set(fileNameKey, bucket);
		}
		bucket.sourcePaths.push(file.path);
		bucket.h1List.push(...h1List);
		bucket.h2Count += h1List.reduce((sum, h1) => sum + h1.h2List.length, 0);
		if (file.stat.ctime < bucket.firstFileCtime) {
			bucket.firstFileCtime = file.stat.ctime;
			bucket.stableKey = String(file.stat.ctime);
		}
	}

	// 清理不再活跃的解析缓存
	pruneGuidebookFileParseCache(guidebookRootPath, activeFilePaths);

	// 转换为标准 GuidebookTreeFileNode 结构
	const fileNodes: GuidebookTreeFileNode[] = Array.from(fileBucketByName.values()).map(bucket => ({
		fileName: bucket.fileName,
		stableKey: String(bucket.firstFileCtime),
		sourcePaths: bucket.sourcePaths,
		h1List: bucket.h1List,
		h2Count: bucket.h2Count,
		isSpecific: false
	}));
	logger.debug("fileNodes:", fileNodes);
	return fileNodes;
}

// ============ 模块2：处理特殊文件夹（人物/势力/地点设定） ============
/**
 * 处理预定义的特殊文件夹（如“人物设定”、“势力设定”、“地点设定”）。
 * - 对于每个特殊文件夹，查找其直接子文件夹（视为 H1 节点）。
 * - 每个子文件夹下的所有 .md 文件视为 H2 节点。
 * - 每个特殊文件夹生成一个 GuidebookTreeFileNode，其中 h1List 为各子文件夹对应的 H1 节点。
 * 
 * @param app Obsidian App 实例
 * @param guidebookRootPath 设定库根目录路径
 * @returns 处理得到的文件节点数组（每个特殊文件夹对应一个节点）
 */
async function processSpecialFolders(app: App, guidebookRootPath: string): Promise<GuidebookTreeFileNode[]> {
	const specialFileNodes: GuidebookTreeFileNode[] = [];

	for (const specialFolderName of SPECIAL_FOLDERS) {
		const specialFolderPath = `${guidebookRootPath}/${specialFolderName}`;
		const specialFolder = app.vault.getAbstractFileByPath(specialFolderPath);
		if (!(specialFolder instanceof TFolder)) continue;

		const subfolders = listSubfolders(app, specialFolderPath);
		if (subfolders.length === 0) {
			specialFileNodes.push({
				fileName: specialFolderName,
				stableKey: `${specialFolderName}`,
				sourcePaths: [specialFolderPath],
				h1List: [],
				h2Count: 0,
				isSpecific: true
			});
			continue;
		}

		const h1List: GuidebookTreeH1Node[] = [];
		let totalH2Count = 0;

		for (const subfolder of subfolders) {
			const mdFiles = listDirectMarkdownFilesInFolder(app, subfolder.path);
			// if (mdFiles.length === 0) continue;

			const h2List: GuidebookTreeH2Node[] = mdFiles.map((file, idx) => ({
				title: file.basename,
				content: '',
				sourcePath: file.path,
				sourceFileCtime: file.stat.ctime,
				sourceFileMtime: file.stat.mtime,
				h1IndexInSource: 0,
				h2IndexInH1: idx,
				isSpecific: true
			}));

			const folderStats = await getFolderStats(app, subfolder);
			const h1Node: GuidebookTreeH1Node = {
				title: subfolder.name,
				h2List,
				sourcePath: subfolder.path,
				sourceFileCtime: folderStats.ctime,
				sourceFileMtime: folderStats.mtime,
				h1IndexInSource: h1List.length,
				isSpecific: true
			};
			h1List.push(h1Node);
			totalH2Count += h2List.length;
		}
		// if (h1List.length > 0) {
		specialFileNodes.push({
			fileName: specialFolderName,
			stableKey: `${specialFolderName}`,
			sourcePaths: [specialFolderPath],
			h1List,
			h2Count: totalH2Count,
			isSpecific: true
		});
		// }
	}
	logger.debug("specialFileNodes", specialFileNodes)
	return specialFileNodes;
}

// ============ 辅助函数：签名生成（用于缓存校验） ============
function generateOtherSettingsSignature(app: App, guidebookRootPath: string): string {
	const otherSettingsFiles = listMarkdownFilesInFolder(app, `${guidebookRootPath}/其他设定`).sort(compareByFileCreationTime);
	const signature = otherSettingsFiles
		.map((file) => `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}\u0000${file.stat.ctime}`)
		.join("\u0001");
	return signature;
}

function generateSpecialFoldersSignature(app: App, guidebookRootPath: string): string {
	const signatureParts: string[] = [];
	for (const specialName of SPECIAL_FOLDERS) {
		const specialPath = `${guidebookRootPath}/${specialName}`;
		const folder = app.vault.getAbstractFileByPath(specialPath);
		if (!(folder instanceof TFolder)) continue;
		const subfolders = listSubfolders(app, specialPath);

		for (const sub of subfolders) {
			signatureParts.push(`${sub.path}\u0000`);
			const files = listDirectMarkdownFilesInFolder(app, sub.path);
			for (const file of files) {
				signatureParts.push(`${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}\u0000${file.stat.ctime}`);
			}
		}
	}
	return signatureParts.join("\u0001");
}

// ============ 辅助函数：文件节点排序（依据文集顺序 + 文件名） ============
function buildCollectionOrderMap(orderedSourcePaths: string[]): Map<string, number> {
	const orderMap = new Map<string, number>();
	orderedSourcePaths.forEach((path, index) => {
		orderMap.set(path, index);
	});
	return orderMap;
}

function sortFileNodesByOrder(
	fileNodes: GuidebookTreeFileNode[],
	collectionOrderMap: Map<string, number>
): GuidebookTreeFileNode[] {
	//todo: 优化文件排序逻辑|固定文件夹置顶
	return fileNodes.sort((a, b) => {
		//有关固定文件夹的排序
		const aIndex = SPECIAL_FOLDERS.indexOf(a.fileName);
		const bIndex = SPECIAL_FOLDERS.indexOf(b.fileName);
		if (aIndex !== -1 && bIndex !== -1) {
			return aIndex - bIndex;
		}
		if (aIndex !== -1) return -1;
		if (bIndex !== -1) return 1;

		const aPath = a.sourcePaths[0] ?? '';
		const bPath = b.sourcePaths[0] ?? '';
		const aRank = collectionOrderMap.get(aPath) ?? Number.MAX_SAFE_INTEGER;
		const bRank = collectionOrderMap.get(bPath) ?? Number.MAX_SAFE_INTEGER;
		if (aRank !== bRank) return aRank - bRank;
		return a.fileName.localeCompare(b.fileName);
	});
}

// ============ 主函数：构建设定库树形数据结构 ============
export async function buildGuidebookTreeData(
	app: App,
	settings: GuidebookTreeBuildSettings,
	activeFilePath: string | null,
): Promise<GuidebookTreeData | null> {
	// ---------- 1. 定位小说库根目录与设定库根目录 ----------
	const libraryService = new NovelLibraryService(app);
	const normalizedLibraryRoots = libraryService.normalizeLibraryRoots(settings.novelLibraries);
	const containingLibraryRoot = activeFilePath
		? libraryService.resolveContainingLibraryRoot(activeFilePath, normalizedLibraryRoots)
		: null;
	if (!containingLibraryRoot) {
		return null;
	}

	const guidebookRootPath = libraryService.resolveNovelLibrarySubdirPath(containingLibraryRoot,
		NOVEL_LIBRARY_SUBDIR_NAMES.guidebook,
	);
	if (!guidebookRootPath) {
		return {
			libraryRootPath: containingLibraryRoot,
			guidebookRootPath: "",
			files: [],
		};
	}

	// ---------- 2. 生成文件签名（用于缓存比对） ----------
	const otherSignature = generateOtherSettingsSignature(app, guidebookRootPath);
	const specialSignature = generateSpecialFoldersSignature(app, guidebookRootPath);
	const guidebookFileSignature = `${otherSignature}\u0001${specialSignature}`;
	const orderedSourcePaths = settings.guidebookCollectionOrders[guidebookRootPath] ?? [];
	const orderedSourcePathsKey = orderedSourcePaths.join("\u0001");

	// ---------- 3. 检查缓存是否命中 ----------
	const cachedTree = guidebookTreeCacheByRootPath.get(guidebookRootPath);
	if (cachedTree && cachedTree.signature === guidebookFileSignature && cachedTree.orderedSourcePathsKey === orderedSourcePathsKey) {
		logger.debug("Datatree has been cached.")
		return cachedTree.data;
	}

	// ---------- 4. 分别处理“其他设定”和“特殊文件夹” ----------
	const otherSettingsNodes = await processOtherSettingsFolder(app, guidebookRootPath);
	const specialFolderNodes = await processSpecialFolders(app, guidebookRootPath);

	// ---------- 5. 合并所有文件节点并统一排序 ----------
	const allFileNodes = [...otherSettingsNodes, ...specialFolderNodes];
	const collectionOrderMap = buildCollectionOrderMap(orderedSourcePaths);
	const sortedAllFiles = sortFileNodesByOrder(allFileNodes, collectionOrderMap);

	// ---------- 6. 构建最终树数据并更新缓存 ----------
	const treeData: GuidebookTreeData = {
		libraryRootPath: containingLibraryRoot,
		guidebookRootPath,
		files: sortedAllFiles,
	};
	guidebookTreeCacheByRootPath.set(guidebookRootPath, {
		signature: guidebookFileSignature,
		orderedSourcePathsKey,
		data: treeData,
	});
	return treeData;
}
import { type App, Notice, TFile, TFolder, type MarkdownView } from "obsidian";
import type { TranslationKey } from "../../lang";
import type {
	GuidebookTreeData,
	GuidebookTreeFileNode,
	GuidebookTreeH1Node,
	GuidebookTreeH2Node,
} from "./tree-builder";
import { GuidebookMarkdownParser } from "./markdown-parser";
import { askForConfirmation, promptTextInput } from "../../ui";
import { openMarkdownFileWithoutDuplicate, splitLines } from "../../utils";
import { logger } from "../../utils/logger";
import characterTemplate from "../../../resources/templates/characterTemplate.md";
import factionTemplate from "../../../resources/templates/factionTemplate.md";
import locationTemplate from "../../../resources/templates/locationTemplate.md";

// ==================== 导出类型定义 ====================
export type GuidebookFileContextAction =
	| "create_collection"
	| "create_category"
	| "rename_collection"
	| "delete_collection";

export type GuidebookH1ContextAction =
	| "create_category"
	| "create_setting"
	| "rename_category"
	| "delete_category";

export type GuidebookH2ContextAction =
	| "create_setting"
	| "edit_setting"
	| "rename_setting"
	| "delete_setting";

// ==================== 内部接口 ====================
interface GuidebookActionContext {
	app: App;
	t: (key: TranslationKey) => string;
	treeData: GuidebookTreeData | null;
	openFileInNewTab?: boolean;
}

interface GuidebookNodeActionExecutor {
	renameCollection(fileNode: GuidebookTreeFileNode): Promise<boolean>;
	deleteCollection(fileNode: GuidebookTreeFileNode): Promise<boolean>;
	createCategory(h1Node: GuidebookTreeFileNode | GuidebookTreeH1Node): Promise<boolean>;
	renameCategory(h1Node: GuidebookTreeH1Node): Promise<boolean>;
	deleteCategory(h1Node: GuidebookTreeH1Node): Promise<boolean>;
	createSetting(h2Node: GuidebookTreeH1Node | GuidebookTreeH2Node): Promise<boolean>;
	editSetting(h2Node: GuidebookTreeH2Node): Promise<boolean>;
	renameSetting(h2Node: GuidebookTreeH2Node): Promise<boolean>;
	deleteSetting(h2Node: GuidebookTreeH2Node): Promise<boolean>;
}

interface GuidebookFileTitlesCacheEntry {
	mtime: number;
	size: number;
	h1Titles: readonly string[];
	h2Titles: readonly string[];
}

interface GuidebookScopeTitlesCacheEntry {
	signature: string;
	h1Titles: readonly string[];
	h2Titles: readonly string[];
}

// ==================== 常量与全局缓存 ====================
const guidebookMarkdownParser = new GuidebookMarkdownParser();
const DUPLICATE_SETTING_ERROR = "cna_guidebook_setting_exists";
const DUPLICATE_CATEGORY_ERROR = "cna_guidebook_category_exists";
const guidebookFileTitlesCacheByPath = new Map<string, GuidebookFileTitlesCacheEntry>();
const guidebookScopeTitlesCacheByKey = new Map<string, GuidebookScopeTitlesCacheEntry>();

// ==================== 辅助函数 ====================
/** 根据节点类型返回对应的执行器（文件系统操作 or Markdown 内容操作） */
function getExecutor(
	app: App,
	t: (key: TranslationKey) => string,
	treeData: GuidebookTreeData | null,
	node: GuidebookTreeFileNode | GuidebookTreeH1Node | GuidebookTreeH2Node
): GuidebookNodeActionExecutor {
	if (node.isSpecific) {
		return fileSystemExecutor(app, t, treeData);
	}
	return markdownExecutor(app, t, treeData);
}

// ==================== Markdown 文件操作执行器 ====================
function markdownExecutor(
	app: App,
	t: (key: TranslationKey) => string,
	treeData: GuidebookTreeData | null
): GuidebookNodeActionExecutor {
	return {
		// 重命名集合（Markdown 文件）
		renameCollection: async (fileNode) => {
			const file = resolveSingleSourceCollectionFile(app, t, fileNode);
			if (!file) return false;
			const parentPath = getParentPath(file.path);
			const collectionName = await promptFileName(app, t, parentPath, {
				title: t("feature.guidebook.dialog.rename_collection.title"),
				placeholder: t("feature.guidebook.dialog.collection_name.placeholder"),
				initialValue: fileNode.fileName,
				validate: (value) => (value === fileNode.fileName ? "" : null),
			});
			if (!collectionName) return false;
			await app.fileManager.renameFile(file, buildMarkdownFilePath(parentPath, collectionName));
			return true;
		},
		// 删除集合（Markdown 文件）
		deleteCollection: async (fileNode) => {
			const file = resolveSingleSourceCollectionFile(app, t, fileNode);
			if (!file) return false;
			const confirmed = await askForConfirmation(app, {
				title: t("feature.guidebook.dialog.delete_collection.title"),
				message: formatTemplate(t("feature.guidebook.dialog.delete_collection.message"), {
					name: file.basename,
				}),
				confirmText: t("settings.common.delete"),
				cancelText: t("settings.common.cancel"),
				confirmIsDanger: true,
			});
			if (!confirmed) return false;
			await app.vault.trash(file, false);
			return true;
		},
		// 创建分类（追加 H1）
		createCategory: async (fNode) => {
			let file: TFile | null = null;
			if ("sourcePaths" in fNode) {
				file = resolveCollectionFileByPath(app, fNode.sourcePaths[0] as string);
			} else {
				file = resolveCollectionFileByPath(app, fNode.sourcePath);
			}
			if (!file) throw new Error("file not found");
			const categoryName = await promptCategoryName(app, t, file, treeData, {
				title: t("feature.guidebook.dialog.create_category.title"),
				placeholder: t("feature.guidebook.dialog.category_name.placeholder"),
				initialValue: "",
			});
			if (!categoryName) return false;
			await appendH1WithUniquenessCheck(app, file, treeData, categoryName);
			return true;
		},
		// 重命名分类（重命名 H1）
		renameCategory: async (h1Node) => {
			const file = resolveCollectionFileByPath(app, h1Node.sourcePath);
			if (!file) throw new Error("file not found");
			const renamed = await promptCategoryName(app, t, file, treeData, {
				title: t("feature.guidebook.dialog.rename_category.title"),
				placeholder: t("feature.guidebook.dialog.category_name.placeholder"),
				initialValue: h1Node.title,
				ignoreTitle: h1Node.title,
			});
			if (!renamed || renamed === h1Node.title) return false;
			await renameH1WithUniquenessCheck(app, file, treeData, h1Node.h1IndexInSource, renamed);
			return true;
		},
		// 删除分类（删除 H1 及其内容）
		deleteCategory: async (h1Node) => {
			const file = resolveCollectionFileByPath(app, h1Node.sourcePath);
			if (!file) throw new Error("file not found");
			const confirmed = await askForConfirmation(app, {
				title: t("feature.guidebook.dialog.delete_category.title"),
				message: formatTemplate(t("feature.guidebook.dialog.delete_category.message"), {
					name: h1Node.title,
				}),
				confirmText: t("settings.common.delete"),
				cancelText: t("settings.common.cancel"),
				confirmIsDanger: true,
			});
			if (!confirmed) return false;
			await app.vault.process(file, (content) => deleteH1(content, h1Node.h1IndexInSource));
			return true;
		},
		// 创建设定（追加 H2）
		createSetting: async (hNode) => {
			const file = resolveCollectionFileByPath(app, hNode.sourcePath);
			if (!file) throw new Error("file not found");
			const settingName = await promptSettingName(app, t, file, hNode.type as "markdown-h1" | "markdown-h2", treeData, {
				title: t("feature.guidebook.dialog.create_setting.title"),
				placeholder: t("feature.guidebook.dialog.setting_name.placeholder"),
				initialValue: "",
			});
			if (!settingName) return false;
			await appendH2WithUniquenessCheck(app, file, treeData, hNode.h1IndexInSource, settingName);
			return true;
		},
		// 编辑设定（打开文件并定位到 H2）
		editSetting: async (h2Node) => {
			const file = resolveCollectionFileByPath(app, h2Node.sourcePath);
			if (!file) throw new Error("file not found");
			const targetPosition = await resolveH2HeadingPosition(app, file, h2Node.title);
			const targetView = await openMarkdownFileWithoutDuplicate(app, file.path, false);
			if (targetPosition && targetView) {
				setMarkdownViewCursor(targetView, targetPosition);
			}
			return false; // 不触发树刷新
		},
		// 重命名设定（重命名 H2）
		renameSetting: async (h2Node) => {
			const file = resolveCollectionFileByPath(app, h2Node.sourcePath);
			if (!file) throw new Error("file not found");
			const newName = await promptSettingName(app, t, file, h2Node.type as "markdown-h1" | "markdown-h2", treeData, {
				title: t("feature.guidebook.dialog.create_setting.title"),
				placeholder: t("feature.guidebook.dialog.setting_name.placeholder"),
				initialValue: h2Node.title,
			});
			if (!newName) return false;
			await renameH2WithUniquenessCheck(
				app,
				file,
				treeData,
				h2Node.h1IndexInSource,
				h2Node.h2IndexInH1,
				newName
			);
			return true;
		},
		// 删除设定（删除 H2）
		deleteSetting: async (h2Node) => {
			const file = resolveCollectionFileByPath(app, h2Node.sourcePath);
			if (!file) throw new Error("file not found");
			const confirmed = await askForConfirmation(app, {
				title: t("feature.guidebook.dialog.delete_setting.title"),
				message: formatTemplate(t("feature.guidebook.dialog.delete_setting.message"), {
					name: h2Node.title,
				}),
				confirmText: t("settings.common.delete"),
				cancelText: t("settings.common.cancel"),
				confirmIsDanger: true,
			});
			if (!confirmed) return false;
			await app.vault.process(file, (content) =>
				deleteH2(content, h2Node.h1IndexInSource, h2Node.h2IndexInH1)
			);
			return true;
		},
	};
}

// ==================== 文件系统操作执行器（用于 specific 文件夹集合）====================
function fileSystemExecutor(
	app: App,
	t: (key: TranslationKey) => string,
	treeData: GuidebookTreeData | null
): GuidebookNodeActionExecutor {
	return {
		createCategory: async (hNode) => {
			const path =
				"sourcePaths" in hNode ? (hNode.sourcePaths?.[0] as string) : hNode.sourcePath;
			if (!path) return false;
			const parentFile =
				hNode.type === "folder"
					? resolveFolderByPath(app, path)
					: resolveFolderByPath(app, getParentPath(path));
			if (!parentFile) return false;
			const categoryName = await promptCategoryName(app, t, parentFile, treeData, {
				title: t("feature.guidebook.dialog.create_category.title"),
				placeholder: t("feature.guidebook.dialog.category_name.placeholder"),
				initialValue: "",
			});
			if (!categoryName) return false;
			await app.vault.createFolder(`${parentFile.path}/${categoryName}`);
			return true;
		},
		renameCategory: async (h1Node) => {
			const folder = app.vault.getFolderByPath(h1Node.sourcePath);
			if (!folder || !folder.parent) throw new Error("folder not found");
			const newName = await promptFolderName(app, t, folder.parent.path, {
				title: t("feature.guidebook.dialog.rename_category.title"),
				placeholder: t("feature.guidebook.dialog.category_name.placeholder"),
				initialValue: h1Node.title,
				validate: (value) =>
					value === h1Node.title ? t("feature.guidebook.validation.exists") : null,
			});
			if (!newName) return false;
			const newPath = `${folder.parent.path}/${newName}`;
			await app.fileManager.renameFile(folder, newPath);
			return true;
		},
		deleteCategory: async (h1Node) => {
			const folder = app.vault.getFolderByPath(h1Node.sourcePath);
			if (!folder) throw new Error("Folder not found");
			const confirmed = await askForConfirmation(app, {
				title: t("feature.guidebook.dialog.delete_category.title"),
				message: formatTemplate(t("feature.guidebook.dialog.delete_category.message"), {
					name: h1Node.title,
				}),
				confirmText: t("settings.common.delete"),
				cancelText: t("settings.common.cancel"),
				confirmIsDanger: true,
			});
			if (!confirmed) return false;
			await app.vault.trash(folder, false);
			return true;
		},
		createSetting: async (hNode) => {
			let folder: TFolder | null = null;
			if (hNode.type === "subfolder") {
				folder = app.vault.getFolderByPath(hNode.sourcePath);
			} else {
				folder = app.vault.getFolderByPath(getParentPath(hNode.sourcePath));
			}
			if (!folder) return false;
			const settingName = await promptFileName(app, t, folder.path, {
				title: t("feature.guidebook.dialog.create_setting.title"),
				placeholder: t("feature.guidebook.dialog.setting_name.placeholder"),
				initialValue: "",
			});
			if (!settingName) return false;
			let template = "";
			const parentFolderName = folder.parent?.name;
			switch (parentFolderName) {
				case "人物设定":
					template = characterTemplate;
					break;
				case "势力设定":
					template = factionTemplate;
					break;
				case "地点设定":
					template = locationTemplate;
					break;
			}
			const targetPath = `${folder.path}/${settingName}.md`;
			await app.vault.create(targetPath, template);
			return true;
		},
		editSetting: async (h2Node) => {
			const file = app.vault.getFileByPath(h2Node.sourcePath);
			if (!file) throw new Error("File not found");
			await openMarkdownFileWithoutDuplicate(app, file.path, false);
			return false;
		},
		renameSetting: async (h2Node) => {
			const file = app.vault.getFileByPath(h2Node.sourcePath);
			if (!file || !file.parent) throw new Error("File not found");
			const newName = await promptFileName(app, t, file.parent.path, {
				title: t("feature.guidebook.dialog.create_setting.title"),
				placeholder: t("feature.guidebook.dialog.setting_name.placeholder"),
				initialValue: file.basename,
				validate: (value) => (file.basename === value ? "Duplicate" : null),
			});
			if (!newName) return false;
			const newPath = buildMarkdownFilePath(file.parent.path, newName);
			await app.vault.rename(file, newPath);
			return true;
		},
		deleteSetting: async (h2Node) => {
			const file = app.vault.getFileByPath(h2Node.sourcePath);
			if (!file) throw new Error("File not found");
			const confirmed = await askForConfirmation(app, {
				title: t("feature.guidebook.dialog.delete_setting.title"),
				message: formatTemplate(t("feature.guidebook.dialog.delete_setting.message"), {
					name: h2Node.title,
				}),
				confirmText: t("settings.common.delete"),
				cancelText: t("settings.common.cancel"),
				confirmIsDanger: true,
			});
			if (!confirmed) return false;
			await app.vault.trash(file, false);
			return true;
		},
		renameCollection: async (fileNode) => {
			const folder = resolveFolderByPath(app, fileNode.sourcePaths[0]!);
			if (!folder || !folder.parent) throw new Error("Folder not found");
			const newName = await promptFolderName(app, t, folder.parent.path, {
				title: t("feature.guidebook.dialog.rename_collection.title"),
				placeholder: t("feature.guidebook.dialog.collection_name.placeholder"),
				initialValue: fileNode.fileName,
			});
			if (!newName || newName === fileNode.fileName) return false;
			const newPath = `${folder.parent.path}/${newName}`;
			await app.fileManager.renameFile(folder, newPath);
			return true;
		},
		deleteCollection: async (fileNode) => {
			const folder = resolveFolderByPath(app, fileNode.sourcePaths[0]!);
			if (!folder) throw new Error("Folder not found");
			const confirmed = await askForConfirmation(app, {
				title: t("feature.guidebook.dialog.delete_collection.title"),
				message: formatTemplate(t("feature.guidebook.dialog.delete_collection.message"), {
					name: fileNode.fileName,
				}),
				confirmText: t("settings.common.delete"),
				cancelText: t("settings.common.cancel"),
				confirmIsDanger: true,
			});
			if (!confirmed) return false;
			await app.vault.trash(folder, false);
			return true;
		},
	};
}

// ==================== 公开的上下文操作入口 ====================
export async function handleGuidebookBlankCreateCollection(context: GuidebookActionContext): Promise<boolean> {
	const { app, t, treeData } = context;
	const guidebookRootPath = treeData?.guidebookRootPath;
	if (!guidebookRootPath) {
		new Notice(t("feature.guidebook.notice.node_not_found"));
		return false;
	}
	const othersSettingPath = `${guidebookRootPath}/其他设定`;
	const collectionName = await promptFileName(app, t, othersSettingPath, {
		title: t("feature.guidebook.dialog.create_collection.title"),
		placeholder: t("feature.guidebook.dialog.collection_name.placeholder"),
		initialValue: "",
	});
	if (!collectionName) return false;
	try {
		await app.vault.create(buildMarkdownFilePath(othersSettingPath, collectionName), "");
		return true;
	} catch (error) {
		console.error(error);
		new Notice(t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

export async function handleGuidebookFileContextAction(
	context: GuidebookActionContext,
	action: GuidebookFileContextAction,
	fileNode: GuidebookTreeFileNode
): Promise<boolean> {
	const { app, t, treeData } = context;
	const executor = getExecutor(app, t, treeData, fileNode);
	try {
		switch (action) {
			case "create_collection":
				return handleGuidebookBlankCreateCollection(context);
			case "create_category":
				return executor.createCategory(fileNode);
			case "rename_collection":
				return executor.renameCollection(fileNode);
			case "delete_collection":
				return executor.deleteCollection(fileNode);
			default:
				return false;
		}
	} catch (error) {
		if (isDuplicateGuidebookTitleError(error)) {
			new Notice(t("feature.guidebook.validation.exists"));
			return false;
		}
		logger.errorUnknown(error);
		new Notice(t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

export async function handleGuidebookH1ContextAction(
	context: GuidebookActionContext,
	action: GuidebookH1ContextAction,
	_fileNode: GuidebookTreeFileNode,
	h1Node: GuidebookTreeH1Node
): Promise<boolean> {
	const { app, t, treeData } = context;
	const executor = getExecutor(app, t, treeData, h1Node);
	try {
		switch (action) {
			case "create_category":
				return executor.createCategory(h1Node);
			case "rename_category":
				return executor.renameCategory(h1Node);
			case "delete_category":
				return executor.deleteCategory(h1Node);
			case "create_setting":
				return executor.createSetting(h1Node);
			default:
				return false;
		}
	} catch (error) {
		if (isDuplicateGuidebookTitleError(error)) {
			new Notice(t("feature.guidebook.validation.exists"));
			return false;
		}
		console.error(error);
		new Notice(t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

export async function handleGuidebookH2ContextAction(
	context: GuidebookActionContext,
	action: GuidebookH2ContextAction,
	_fileNode: GuidebookTreeFileNode,
	_h1Node: GuidebookTreeH1Node,
	h2Node: GuidebookTreeH2Node
): Promise<boolean> {
	const { app, t, treeData } = context;
	const executor = getExecutor(app, t, treeData, h2Node);
	try {
		switch (action) {
			case "create_setting":
				return executor.createSetting(h2Node);
			case "edit_setting":
				return executor.editSetting(h2Node);
			case "rename_setting":
				return executor.renameSetting(h2Node);
			case "delete_setting":
				return executor.deleteSetting(h2Node);
			default:
				return false;
		}
	} catch (error) {
		if (isDuplicateGuidebookTitleError(error)) {
			new Notice(t("feature.guidebook.validation.exists"));
			return false;
		}
		console.error(error);
		new Notice(t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

/**
 * 将选中的文本作为新词条（H2）添加到指南手册文件的指定分类（H1）下，或者根据 isSpecial 创建独立文件
 * @param context 操作上下文
 * @param sourcePath 源路径：普通模式下为 Markdown 文件路径；特殊模式下为文件夹路径
 * @param h1IndexInSource 目标 H1 索引（普通模式使用）
 * @param settingName 设定名称（普通模式下为 H2 标题，特殊模式下作为文件名的备选）
 * @param h1Title H1 标题（特殊模式下用作文件名）
 * @param isSpecial 是否为特殊模式，若为 true 则在 sourcePath 文件夹下创建独立 Markdown 文件
 */
export async function appendGuidebookSettingToCategoryByPath(
	context: GuidebookActionContext,
	sourcePath: string,
	h1IndexInSource: number,
	settingName: string,
	h1Title?: string,
	isSpecial?: boolean,
): Promise<boolean> {
	const { app, t, treeData } = context;

	// ========== 特殊模式：在文件夹下创建独立 Markdown 文件 ==========
	if (isSpecial) {
		// 验证 sourcePath 是否为文件夹
		const folder = app.vault.getFolderByPath(sourcePath);
		if (!folder) {
			new Notice(t("feature.guidebook.notice.node_not_found"));
			return false;
		}
		// 确定文件名：优先使用 h1Title，回退到 settingName
		const fileName = settingName.trim();
		if (!fileName) {
			new Notice(t("feature.guidebook.validation.empty"));
			return false;
		}
		// 校验文件名合法性
		if (/[\\/:*?"<>|]/.test(fileName)) {
			new Notice(t("feature.guidebook.validation.invalid_name"));
			return false;
		}
		const filePath = `${folder.path}/${fileName}.md`;
		if (app.vault.getAbstractFileByPath(filePath)) {
			new Notice(t("feature.guidebook.validation.exists"));
			return false;
		}
		// 根据父文件夹名称选择模板
		let template = "";
		const parentFolderName = folder.parent?.name;
		switch (parentFolderName) {
			case "人物设定":
				template = characterTemplate;
				break;
			case "势力设定":
				template = factionTemplate;
				break;
			case "地点设定":
				template = locationTemplate;
				break;
			default:
				template = ""; // 无模板则创建空文件
		}
		try {
			await app.vault.create(filePath, template);
			return true;
		} catch (error) {
			console.error(error);
			new Notice(t("feature.guidebook.notice.action_failed"));
			return false;
		}
	}

	// ========== 普通模式：向现有 Markdown 文件追加 H2 条目 ==========
	const file = resolveCollectionFileByPath(app, sourcePath);
	if (!file) {
		new Notice(t("feature.guidebook.notice.node_not_found"));
		return false;
	}

	const normalizedSettingName = settingName.trim();
	if (normalizedSettingName.length === 0) {
		new Notice(t("feature.guidebook.validation.empty"));
		return false;
	}

	try {
		let targetH1Index = h1IndexInSource;
		const normalizedH1Title = h1Title?.trim();
		if (normalizedH1Title && normalizedH1Title.length > 0) {
			const resolvedH1Index = await resolveH1IndexByTitle(app, file, normalizedH1Title);
			if (resolvedH1Index >= 0) {
				targetH1Index = resolvedH1Index;
			}
		}
		await appendH2WithUniquenessCheck(app, file, treeData, targetH1Index, normalizedSettingName);
		return true;
	} catch (error) {
		if (isDuplicateGuidebookTitleError(error)) {
			new Notice(t("feature.guidebook.validation.exists"));
			return false;
		}
		console.error(error);
		new Notice(t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

// ==================== 内部工具函数 ====================
/** 获取父路径 */
function getParentPath(path: string): string {
	const slashIndex = path.lastIndexOf("/");
	return slashIndex >= 0 ? path.slice(0, slashIndex) : "";
}

/** 构建 Markdown 文件的完整路径 */
function buildMarkdownFilePath(parentPath: string, fileName: string): string {
	return `${parentPath}/${fileName}.md`;
}

/** 弹出文件名称输入框（自动校验空、非法字符、是否存在） */
async function promptFileName(
	app: App,
	t: (key: TranslationKey) => string,
	parentPath: string,
	options: {
		title: string;
		placeholder: string;
		initialValue: string;
		validate?: (normalizedName: string) => string | null;
	}
): Promise<string | null> {
	return promptTextInput(app, {
		title: options.title,
		placeholder: options.placeholder,
		initialValue: options.initialValue,
		confirmText: t("settings.common.confirm"),
		cancelText: t("settings.common.cancel"),
		normalize: (value) => value.trim().replace(/\.md$/i, ""),
		validate: (value) => {
			if (!value) return t("feature.guidebook.validation.empty");
			if (/[\\/:*?"<>|]/.test(value)) return t("feature.guidebook.validation.invalid_name");
			const fullPath = buildMarkdownFilePath(parentPath, value);
			if (app.vault.getAbstractFileByPath(fullPath)) {
				return t("feature.guidebook.validation.exists");
			}
			const externalValidate = options.validate?.(value);
			if (externalValidate) return externalValidate;
			return null;
		},
	});
}

/** 弹出标题名称输入框（用于 H1/H2 标题） */
async function promptHeadingName(
	app: App,
	t: (key: TranslationKey) => string,
	options: {
		title: string;
		placeholder: string;
		initialValue: string;
		validate?: (value: string) => string | null;
	}
): Promise<string | null> {
	return promptTextInput(app, {
		title: options.title,
		placeholder: options.placeholder,
		initialValue: options.initialValue,
		confirmText: t("settings.common.confirm"),
		cancelText: t("settings.common.cancel"),
		normalize: (value) => value.trim(),
		validate: (value) => {
			if (!value) return t("feature.guidebook.validation.empty");
			if (/[\r\n]/.test(value)) return t("feature.guidebook.validation.invalid_name");
			const customValidationMessage = options.validate?.(value);
			if (customValidationMessage) return customValidationMessage;
			return null;
		},
	});
}

/** 弹出文件夹名称输入框（自动校验空、非法字符、是否已存在） */
async function promptFolderName(
	app: App,
	t: (key: TranslationKey) => string,
	parentFolderPath: string,
	options: {
		title: string;
		placeholder: string;
		initialValue?: string;
		validate?: (value: string) => string | null;
	}
): Promise<string | null> {
	return promptTextInput(app, {
		title: options.title,
		placeholder: options.placeholder,
		initialValue: options.initialValue ?? "",
		confirmText: t("settings.common.confirm"),
		cancelText: t("settings.common.cancel"),
		normalize: (value) => value.trim(),
		validate: (value) => {
			if (!value) return t("feature.guidebook.validation.empty");
			if (/[\\/:*?"<>|]/.test(value)) return "文件夹名无效";
			const fullPath = `${parentFolderPath}/${value}`;
			if (app.vault.getAbstractFileByPath(fullPath) instanceof TFolder) return "文件夹已存在";
			const externalValidate = options.validate?.(value);
			if (externalValidate) return externalValidate;
			return null;
		},
	});
}

/** 根据节点类型弹出设定名称输入框（统一处理 H1/H2 的重复校验） */
async function promptSettingName(
	app: App,
	t: (key: TranslationKey) => string,
	f: TFile,
	nodeType: "markdown-h1" | "markdown-h2",
	treeData: GuidebookTreeData | null,
	options: {
		title: string;
		placeholder: string;
		initialValue: string;
		ignoreTitle?: string;
	}
): Promise<string | null> {
	switch (nodeType) {
		case "markdown-h1": {
			const existingTitles = await collectAllCollectionH1Titles(app, f, treeData, options.ignoreTitle);
			return promptHeadingName(app, t, {
				...options,
				validate: (value) =>
					existingTitles.has(value) ? t("feature.guidebook.validation.exists") : null,
			});
		}
		case "markdown-h2": {
			const existingTitles = await collectAllCollectionH2Titles(app, f, treeData, options.ignoreTitle);
			return promptHeadingName(app, t, {
				...options,
				validate: (value) =>
					existingTitles.has(value) ? t("feature.guidebook.validation.exists") : null,
			});
		}
		default:
			return null;
	}
}

/** 弹出分类名称输入框（自动区分 TFile 或 TFolder，做相应校验） */
async function promptCategoryName(
	app: App,
	t: (key: TranslationKey) => string,
	f: TFile | TFolder,
	treeData: GuidebookTreeData | null,
	options: {
		title: string;
		placeholder: string;
		initialValue: string;
		ignoreTitle?: string;
	}
): Promise<string | null> {
	if (f instanceof TFile) {
		const existingTitles = await collectAllCollectionH1Titles(app, f, treeData, options.ignoreTitle);
		return promptHeadingName(app, t, {
			...options,
			validate: (value) =>
				existingTitles.has(value) ? t("feature.guidebook.validation.exists") : null,
		});
	} else {
		return promptFolderName(app, t, f.path, { ...options });
	}
}

/** 通过路径获取 TFile 对象 */
function resolveCollectionFileByPath(app: App, path: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

/** 通过路径获取 TFolder 对象 */
function resolveFolderByPath(app: App, path: string): TFolder | null {
	const file = app.vault.getAbstractFileByPath(path);
	return file instanceof TFolder ? file : null;
}

/** 从文件节点中解析出单个源文件（用于 specific 节点） */
function resolveSingleSourceCollectionFile(
	app: App,
	_t: (key: TranslationKey) => string,
	fileNode: GuidebookTreeFileNode
): TFile | null {
	return resolveCollectionFileByPath(app, fileNode.sourcePaths[0] ?? "");
}

/** 根据标题查找文件中 H1 的索引 */
async function resolveH1IndexByTitle(app: App, file: TFile, h1Title: string): Promise<number> {
	const markdown = await app.vault.cachedRead(file);
	const h1List = guidebookMarkdownParser.parseTree(markdown);
	for (let index = 0; index < h1List.length; index++) {
		const currentTitle = h1List[index]?.title?.trim() ?? "";
		if (currentTitle === h1Title) return index;
	}
	return -1;
}

/** 解析 H2 标题在文件中的行号位置 */
async function resolveH2HeadingPosition(
	app: App,
	file: TFile,
	headingTitle: string
): Promise<{ line: number; ch: number } | null> {
	const normalizedTitle = headingTitle.trim();
	if (normalizedTitle.length === 0) return null;
	const content = await app.vault.cachedRead(file);
	const lines = content.split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const lineText = lines[lineIndex] ?? "";
		const parsedTitle = parseH2HeadingTitle(lineText);
		if (parsedTitle && parsedTitle === normalizedTitle) {
			return { line: lineIndex, ch: lineText.length };
		}
	}
	return null;
}

/** 解析一行是否为 H2 标题，并返回标题文本 */
function parseH2HeadingTitle(line: string): string | null {
	const match = line.match(/^\s{0,3}(#{2})[ \t]+(.*)$/);
	if (!match || !match[1]) return null;
	let title = (match[2] ?? "").trim();
	title = title.replace(/[ \t]+#+[ \t]*$/, "").trim();
	return title.length > 0 ? title : null;
}

/** 设置 Markdown 编辑器的光标位置 */
function setMarkdownViewCursor(view: MarkdownView, position: { line: number; ch: number }): void {
	const editorAny = view.editor as unknown as {
		setCursor?: (line: number, ch: number) => void;
		scrollIntoView?: (
			range: { from: { line: number; ch: number }; to: { line: number; ch: number } },
			center?: boolean
		) => void;
	};
	editorAny.setCursor?.(position.line, position.ch);
	editorAny.scrollIntoView?.(
		{ from: { line: position.line, ch: position.ch }, to: { line: position.line, ch: position.ch } },
		true
	);
}

/** 判断错误是否为重复标题错误 */
function isDuplicateGuidebookTitleError(error: unknown): boolean {
	return error instanceof Error && (error.message === DUPLICATE_SETTING_ERROR || error.message === DUPLICATE_CATEGORY_ERROR);
}

/** 追加 H1 并检查唯一性 */
async function appendH1WithUniquenessCheck(
	app: App,
	file: TFile,
	treeData: GuidebookTreeData | null,
	categoryName: string
): Promise<void> {
	const existingTitles = await collectAllCollectionH1Titles(app, file, treeData);
	if (existingTitles.has(categoryName)) {
		throw new Error(DUPLICATE_CATEGORY_ERROR);
	}
	await app.vault.process(file, (content) => {
		if (collectH1Titles(content).has(categoryName)) {
			throw new Error(DUPLICATE_CATEGORY_ERROR);
		}
		return appendH1(content, categoryName);
	});
}

/** 追加 H2 并检查唯一性 */
async function appendH2WithUniquenessCheck(
	app: App,
	file: TFile,
	treeData: GuidebookTreeData | null,
	h1Index: number,
	settingName: string
): Promise<void> {
	const existingTitles = await collectAllCollectionH2Titles(app, file, treeData);
	if (existingTitles.has(settingName)) {
		throw new Error(DUPLICATE_SETTING_ERROR);
	}
	await app.vault.process(file, (content) => {
		if (collectH2Titles(content).has(settingName)) {
			throw new Error(DUPLICATE_SETTING_ERROR);
		}
		return appendH2(content, h1Index, settingName);
	});
}

/** 重命名 H1 并检查唯一性 */
async function renameH1WithUniquenessCheck(
	app: App,
	file: TFile,
	treeData: GuidebookTreeData | null,
	h1Index: number,
	nextTitle: string
): Promise<void> {
	const existingTitles = await collectAllCollectionH1Titles(app, file, treeData);
	if (existingTitles.has(nextTitle)) {
		throw new Error(DUPLICATE_CATEGORY_ERROR);
	}
	await app.vault.process(file, (content) => {
		const parsed = guidebookMarkdownParser.parseTree(content);
		const currentTitle = parsed[h1Index]?.title?.trim() ?? "";
		const titleSet = collectH1Titles(content);
		if (currentTitle.length > 0) titleSet.delete(currentTitle);
		if (titleSet.has(nextTitle.trim())) {
			throw new Error(DUPLICATE_CATEGORY_ERROR);
		}
		return renameH1(content, h1Index, nextTitle);
	});
}

/** 重命名 H2 并检查唯一性 */
async function renameH2WithUniquenessCheck(
	app: App,
	file: TFile,
	treeData: GuidebookTreeData | null,
	h1Index: number,
	h2Index: number,
	nextTitle: string
): Promise<void> {
	const existingTitles = await collectAllCollectionH2Titles(app, file, treeData);
	if (existingTitles.has(nextTitle)) {
		throw new Error(DUPLICATE_SETTING_ERROR);
	}
	await app.vault.process(file, (content) => {
		const parsed = guidebookMarkdownParser.parseTree(content);
		const currentTitle = parsed[h1Index]?.h2List[h2Index]?.title?.trim() ?? "";
		const titleSet = collectH2Titles(content);
		if (currentTitle.length > 0) titleSet.delete(currentTitle);
		if (titleSet.has(nextTitle.trim())) {
			throw new Error(DUPLICATE_SETTING_ERROR);
		}
		return renameH2(content, h1Index, h2Index, nextTitle);
	});
}

/** 收集文件中所有 H1 标题（去重） */
function collectH1Titles(content: string): Set<string> {
	const titles = new Set<string>();
	const h1List = guidebookMarkdownParser.parseTree(content);
	for (const h1Node of h1List) {
		const title = h1Node.title.trim();
		if (title.length > 0) titles.add(title);
	}
	return titles;
}

/** 收集文件中所有 H2 标题（去重） */
function collectH2Titles(content: string): Set<string> {
	const titles = new Set<string>();
	const h1List = guidebookMarkdownParser.parseTree(content);
	for (const h1Node of h1List) {
		for (const h2Node of h1Node.h2List) {
			const title = h2Node.title.trim();
			if (title.length > 0) titles.add(title);
		}
	}
	return titles;
}

/** 收集当前集合作用域内所有 H1 标题（基于缓存） */
async function collectAllCollectionH1Titles(
	app: App,
	currentFile: TFile,
	treeData: GuidebookTreeData | null,
	excludeTitle?: string
): Promise<Set<string>> {
	const { h1Titles } = await resolveCollectionScopeTitles(app, currentFile, treeData);
	const titles = new Set(h1Titles);
	const normalizedExcludeTitle = excludeTitle?.trim();
	if (normalizedExcludeTitle && normalizedExcludeTitle.length > 0) {
		titles.delete(normalizedExcludeTitle);
	}
	return titles;
}

/** 收集当前集合作用域内所有 H2 标题（基于缓存） */
async function collectAllCollectionH2Titles(
	app: App,
	currentFile: TFile,
	treeData: GuidebookTreeData | null,
	excludeTitle?: string
): Promise<Set<string>> {
	const { h2Titles } = await resolveCollectionScopeTitles(app, currentFile, treeData);
	const titles = new Set(h2Titles);
	const normalizedExcludeTitle = excludeTitle?.trim();
	if (normalizedExcludeTitle && normalizedExcludeTitle.length > 0) {
		titles.delete(normalizedExcludeTitle);
	}
	return titles;
}

/** 获取当前集合作用域内所有标题（目前仅当前文件，预留扩展） */
function resolveCollectionFilesForUniquenessCheck(
	_app: App,
	currentFile: TFile,
	_treeData: GuidebookTreeData | null
): TFile[] {
	return [currentFile];
}

/** 解析集合作用域内的所有标题（带缓存） */
async function resolveCollectionScopeTitles(
	app: App,
	currentFile: TFile,
	treeData: GuidebookTreeData | null
): Promise<{ h1Titles: readonly string[]; h2Titles: readonly string[] }> {
	const files = resolveCollectionFilesForUniquenessCheck(app, currentFile, treeData);
	const scopeKey = resolveCollectionScopeCacheKey(currentFile);
	const signature = buildCollectionScopeSignature(files);
	const cachedScope = guidebookScopeTitlesCacheByKey.get(scopeKey);
	if (cachedScope && cachedScope.signature === signature) {
		return { h1Titles: cachedScope.h1Titles, h2Titles: cachedScope.h2Titles };
	}
	const h1TitleSet = new Set<string>();
	const h2TitleSet = new Set<string>();
	for (const file of files) {
		const fileTitles = await resolveFileTitles(app, file);
		for (const title of fileTitles.h1Titles) h1TitleSet.add(title);
		for (const title of fileTitles.h2Titles) h2TitleSet.add(title);
	}
	const entry: GuidebookScopeTitlesCacheEntry = {
		signature,
		h1Titles: Array.from(h1TitleSet),
		h2Titles: Array.from(h2TitleSet),
	};
	guidebookScopeTitlesCacheByKey.set(scopeKey, entry);
	return { h1Titles: entry.h1Titles, h2Titles: entry.h2Titles };
}

/** 解析单个文件中的所有标题（带文件级缓存） */
async function resolveFileTitles(
	app: App,
	file: TFile
): Promise<{ h1Titles: readonly string[]; h2Titles: readonly string[] }> {
	const cached = guidebookFileTitlesCacheByPath.get(file.path);
	if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
		return { h1Titles: cached.h1Titles, h2Titles: cached.h2Titles };
	}
	const content = await app.vault.cachedRead(file);
	const parsed = guidebookMarkdownParser.parseTree(content);
	const h1TitleSet = new Set<string>();
	const h2TitleSet = new Set<string>();
	for (const h1Node of parsed) {
		const h1Title = h1Node.title.trim();
		if (h1Title.length > 0) h1TitleSet.add(h1Title);
		for (const h2Node of h1Node.h2List) {
			const h2Title = h2Node.title.trim();
			if (h2Title.length > 0) h2TitleSet.add(h2Title);
		}
	}
	const entry: GuidebookFileTitlesCacheEntry = {
		mtime: file.stat.mtime,
		size: file.stat.size,
		h1Titles: Array.from(h1TitleSet),
		h2Titles: Array.from(h2TitleSet),
	};
	guidebookFileTitlesCacheByPath.set(file.path, entry);
	return { h1Titles: entry.h1Titles, h2Titles: entry.h2Titles };
}

/** 生成集合作用域缓存的 key */
function resolveCollectionScopeCacheKey(currentFile: TFile): string {
	return `file:${currentFile.path}`;
}

/** 根据文件列表生成签名，用于判断缓存是否有效 */
function buildCollectionScopeSignature(files: TFile[]): string {
	const orderedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
	return orderedFiles.map((f) => `${f.path}\u0000${f.stat.mtime}\u0000${f.stat.size}`).join("\u0001");
}

// ==================== Markdown 内容操作（字符串级）====================
/** 在文件末尾追加 H1 */
function appendH1(content: string, headingTitle: string): string {
	const lines = splitLines(content);
	lines.push(`# ${headingTitle}`);
	return joinLines(lines);
}

/** 在指定 H1 区块内追加 H2 */
function appendH2(content: string, h1Index: number, headingTitle: string): string {
	const lines = splitLines(content);
	const parsed = guidebookMarkdownParser.parseSections(content);
	const targetH1 = parsed.h1Sections[h1Index];
	if (!targetH1) throw new Error("H1 section not found");
	const insertAt = targetH1.endLine;
	lines.splice(insertAt, 0, `## ${headingTitle}`);
	return joinLines(lines);
}

/** 重命名指定索引的 H1 */
function renameH1(content: string, h1Index: number, nextTitle: string): string {
	const lines = splitLines(content);
	const parsed = guidebookMarkdownParser.parseSections(content);
	const targetH1 = parsed.h1Sections[h1Index];
	if (!targetH1) throw new Error("H1 section not found");
	lines[targetH1.startLine] = `# ${nextTitle}`;
	return joinLines(lines);
}

/** 重命名指定 H1/H2 索引的 H2 */
function renameH2(content: string, h1Index: number, h2Index: number, nextTitle: string): string {
	const lines = splitLines(content);
	const parsed = guidebookMarkdownParser.parseSections(content);
	const targetH1 = parsed.h1Sections[h1Index];
	const targetH2 = targetH1?.h2Sections[h2Index];
	if (!targetH2) throw new Error("H2 section not found");
	lines[targetH2.startLine] = `## ${nextTitle}`;
	return joinLines(lines);
}

/** 删除整个 H1 及其所有内容 */
function deleteH1(content: string, h1Index: number): string {
	const lines = splitLines(content);
	const parsed = guidebookMarkdownParser.parseSections(content);
	const targetH1 = parsed.h1Sections[h1Index];
	if (!targetH1) throw new Error("H1 section not found");
	removeLineRange(lines, targetH1.startLine, targetH1.endLine);
	return joinLines(lines);
}

/** 删除指定 H1 内的某个 H2 及其内容 */
function deleteH2(content: string, h1Index: number, h2Index: number): string {
	const lines = splitLines(content);
	const parsed = guidebookMarkdownParser.parseSections(content);
	const targetH1 = parsed.h1Sections[h1Index];
	const targetH2 = targetH1?.h2Sections[h2Index];
	if (!targetH2) throw new Error("H2 section not found");
	removeLineRange(lines, targetH2.startLine, targetH2.endLine);
	return joinLines(lines);
}

/** 删除指定行范围，并自动清理相邻的空行 */
function removeLineRange(lines: string[], startLine: number, endLine: number): void {
	let removeStart = startLine;
	let removeEnd = endLine;
	while (removeStart > 0 && lines[removeStart - 1]?.trim() === "") removeStart--;
	while (removeEnd < lines.length && lines[removeEnd]?.trim() === "") removeEnd++;
	lines.splice(removeStart, removeEnd - removeStart);
}

/** 将行数组拼接为字符串（保留换行） */
function joinLines(lines: string[]): string {
	return lines.join("\n");
}

/** 替换模板字符串中的 {key} 占位符 */
function formatTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_match, token: string) => values[token] ?? "");
}
import { type App, Notice, TFile } from "obsidian";
import type { TranslationKey } from "../../lang";
import { type SettingDatas } from "../../core";
import { areStringArraysEqual, clamp, splitLines } from "../../utils";
import { GuidebookMarkdownParser } from "./markdown-parser";
import type {
	GuidebookTreeData,
	GuidebookTreeFileNode,
	GuidebookTreeH1Node,
	GuidebookTreeH2Node,
} from "./tree-builder";
import { logger } from "../../utils/logger";

type DragDropPosition = "before" | "after" | "inside";

export type GuidebookTreeDragMoveRequest =
	| {
		kind: "markdown-file" | "folder";
		sourceFileNode: GuidebookTreeFileNode;
		targetFileNode: GuidebookTreeFileNode;
		position: Exclude<DragDropPosition, "inside">;
	}
	| {
		kind: "markdown-h1" | "subfolder";
		sourceFileNode: GuidebookTreeFileNode;
		sourceH1Node: GuidebookTreeH1Node;
		targetFileNode: GuidebookTreeFileNode;
		targetH1Node?: GuidebookTreeH1Node;
		position: DragDropPosition;
	}
	| {
		kind: "markdown-h2" | "markdown-info-file";
		sourceFileNode: GuidebookTreeFileNode;
		sourceH1Node: GuidebookTreeH1Node;
		sourceH2Node: GuidebookTreeH2Node;
		targetFileNode: GuidebookTreeFileNode;
		targetH1Node: GuidebookTreeH1Node;
		targetH2Node?: GuidebookTreeH2Node;
		position: DragDropPosition;
	};

export interface GuidebookTreeDragSortContext {
	app: App;
	t: (key: TranslationKey) => string;
	treeData: GuidebookTreeData | null;
	getSettings: () => SettingDatas;
	setSettings: (patch: Partial<SettingDatas>) => Promise<void>;
}

const markdownParser = new GuidebookMarkdownParser();

export async function handleGuidebookTreeDragMove(
	context: GuidebookTreeDragSortContext,
	request: GuidebookTreeDragMoveRequest,
): Promise<boolean> {
	switch (request.kind) {
		case "markdown-file":
			return handleCollectionMove(context, request);
		case "markdown-h1":
			return handleH1Move(context, request);
		case "markdown-h2":
			return handleH2Move(context, request);
		case "subfolder":
			return handleSubfolderMove(context, request);
		case "markdown-info-file":
			return handleInfoFileMove(context, request);
		default:
			return false;
	}
}

async function handleCollectionMove(
	context: GuidebookTreeDragSortContext,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-file" | "folder" }>,
): Promise<boolean> {
	const guidebookRootPath = context.treeData?.guidebookRootPath;
	if (!guidebookRootPath) {
		new Notice(context.t("feature.guidebook.notice.node_not_found"));
		return false;
	}

	const sourcePath = resolveSingleSourceCollectionPath(context, request.sourceFileNode);
	const targetPath = resolveSingleSourceCollectionPath(context, request.targetFileNode);
	if (!sourcePath || !targetPath || sourcePath === targetPath) {
		return false;
	}

	const baseOrder = collectOrderedCollectionPaths(context.treeData);
	const nextOrder = movePathInArray(baseOrder, sourcePath, targetPath, request.position);
	if (nextOrder.length === 0 || areStringArraysEqual(baseOrder, nextOrder)) {
		return false;
	}

	const settings = context.getSettings();
	await context.setSettings({
		guidebookCollectionOrders: {
			...settings.guidebookCollectionOrders,
			[guidebookRootPath]: nextOrder,
		},
	});
	return true;
}

async function handleH1Move(
	context: GuidebookTreeDragSortContext,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h1" | "subfolder" }>,
): Promise<boolean> {
	const sourceFile = resolveCollectionFileByPath(context.app, request.sourceH1Node.sourcePath);
	if (!sourceFile) {
		new Notice(context.t("feature.guidebook.notice.node_not_found"));
		return false;
	}

	const targetPath = request.targetH1Node?.sourcePath ?? resolveSingleSourcePath(request.targetFileNode);
	if (!targetPath) {
		new Notice(context.t("feature.guidebook.notice.collection_multi_source_unsupported"));
		return false;
	}

	const targetFile = resolveCollectionFileByPath(context.app, targetPath);
	if (!targetFile) {
		new Notice(context.t("feature.guidebook.notice.node_not_found"));
		return false;
	}

	try {
		if (sourceFile.path === targetFile.path) {
			let changed = false;
			await context.app.vault.process(sourceFile, (content) => {
				const next = moveH1WithinContent(content, request);
				changed = next !== content;
				return next;
			});
			return changed;
		}

		const sourceContent = await context.app.vault.cachedRead(sourceFile);
		const targetContent = await context.app.vault.cachedRead(targetFile);
		const moved = moveH1AcrossContents(sourceContent, targetContent, request);
		if (!moved) {
			return false;
		}
		await context.app.vault.process(sourceFile, () => moved.sourceContent);
		await context.app.vault.process(targetFile, () => moved.targetContent);
		return true;
	} catch (error) {
		console.error(error);
		new Notice(context.t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

async function handleH2Move(
	context: GuidebookTreeDragSortContext,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h2" | "markdown-info-file" }>,
): Promise<boolean> {
	const sourceFile = resolveCollectionFileByPath(context.app, request.sourceH2Node.sourcePath);
	const targetFile = resolveCollectionFileByPath(context.app, request.targetH1Node.sourcePath);
	if (!sourceFile || !targetFile) {
		new Notice(context.t("feature.guidebook.notice.node_not_found"));
		return false;
	}

	try {
		if (sourceFile.path === targetFile.path) {
			let changed = false;
			await context.app.vault.process(sourceFile, (content) => {
				const next = moveH2WithinContent(content, request);
				changed = next !== content;
				return next;
			});
			return changed;
		}

		const sourceContent = await context.app.vault.cachedRead(sourceFile);
		const targetContent = await context.app.vault.cachedRead(targetFile);
		const moved = moveH2AcrossContents(sourceContent, targetContent, request);
		if (!moved) {
			return false;
		}
		await context.app.vault.process(sourceFile, () => moved.sourceContent);
		await context.app.vault.process(targetFile, () => moved.targetContent);
		return true;
	} catch (error) {
		console.error(error);
		new Notice(context.t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

async function handleSubfolderMove(
	context: GuidebookTreeDragSortContext,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h1" | "subfolder" }>,
): Promise<boolean> {
	if (request.kind !== "subfolder") {
		return false;
	}
	const sourceSubfolder = context.app.vault.getFolderByPath(request.sourceH1Node.sourcePath);
	if (!sourceSubfolder) {
		new Notice("No source-Subfolder found.");
		return false;
	}
	const targetFolderPath = request.targetFileNode.sourcePaths[0];
	if (!targetFolderPath) return false;
	const targetFolder = context.app.vault.getFolderByPath(targetFolderPath);
	if (!targetFolder) {
		new Notice("No target-Folder found.");
		return false;
	}
	if (sourceSubfolder.parent?.path === targetFolder.path) {
		return false;
	}
	let newPath: string;
	const subfolderName = sourceSubfolder.name;

	if (request.position === "inside" || request.position === "before" || request.position === "after") {
		newPath = `${targetFolderPath}/${subfolderName}`;
	} else {
		return false;
	}

	if (context.app.vault.getFolderByPath(newPath)) {
		new Notice("Already exists.");
		return false;
	}

	try {
		await context.app.vault.rename(sourceSubfolder, newPath);
		return true;
	} catch (error) {
		logger.errorUnknown(error);
		new Notice(context.t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

async function handleInfoFileMove(
	context: GuidebookTreeDragSortContext,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h2" | "markdown-info-file" }>,
) {
	const sourcePath = request.sourceH2Node.sourcePath;
	if (!sourcePath) {
		new Notice(context.t("feature.guidebook.notice.node_not_found"));
		return false;
	}
	const sourceFile = resolveCollectionFileByPath(context.app, sourcePath);
	if (!sourceFile) {
		new Notice(context.t("feature.guidebook.notice.node_not_found"));
		return false;
	}
	const targetFolderPath = request.targetH1Node.sourcePath;
	if (!targetFolderPath) {
		new Notice(context.t("feature.guidebook.notice.collection_multi_source_unsupported"));
		return false;
	}
	const targetFolder = context.app.vault.getFolderByPath(targetFolderPath);
	if (!targetFolder) {
		new Notice(context.t("feature.guidebook.notice.node_not_found"));
		return false;
	}

	if (request.sourceH1Node.sourcePath === targetFolder.path) {
		return false;
	}

	const newPath = `${targetFolder.path}/${sourceFile.name}`;
	if (newPath === sourcePath) {
		return true;
	}
	if (context.app.vault.getFileByPath(newPath)) {
		new Notice("Same named file already exsits.");
		return false;
	}

	try {
		await context.app.fileManager.renameFile(sourceFile, newPath);
		return true;
	} catch (error) {
		console.error(error);
		new Notice(context.t("feature.guidebook.notice.action_failed"));
		return false;
	}
}

function moveH1WithinContent(
	content: string,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h1" | "subfolder" }>,
): string {
	const lines = splitLines(content);
	const parsed = markdownParser.parseSections(content);
	const sourceSection = parsed.h1Sections[request.sourceH1Node.h1IndexInSource];
	if (!sourceSection) {
		throw new Error("H1 source section not found");
	}
	const insertLine = resolveH1InsertLine(lines.length, parsed, request);
	const movedLines = moveLineRange(lines, sourceSection.startLine, sourceSection.endLine, insertLine);
	return joinLines(movedLines);
}

function moveH2WithinContent(
	content: string,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h2" | "markdown-info-file" }>,
): string {
	const lines = splitLines(content);
	const parsed = markdownParser.parseSections(content);
	const sourceH1 = parsed.h1Sections[request.sourceH2Node.h1IndexInSource];
	const sourceH2 = sourceH1?.h2Sections[request.sourceH2Node.h2IndexInH1];
	if (!sourceH2) {
		throw new Error("H2 source section not found");
	}
	const insertLine = resolveH2InsertLine(parsed, request);
	const movedLines = moveLineRange(lines, sourceH2.startLine, sourceH2.endLine, insertLine);
	return joinLines(movedLines);
}

function moveH1AcrossContents(
	sourceContent: string,
	targetContent: string,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h1" | "subfolder" }>,
): { sourceContent: string; targetContent: string } | null {
	const sourceLines = splitLines(sourceContent);
	const sourceParsed = markdownParser.parseSections(sourceContent);
	const sourceSection = sourceParsed.h1Sections[request.sourceH1Node.h1IndexInSource];
	if (!sourceSection) {
		throw new Error("H1 source section not found");
	}

	const movedBlock = sourceLines.slice(sourceSection.startLine, sourceSection.endLine);
	if (movedBlock.length === 0) {
		return null;
	}

	const sourceNextLines = removeLineRange(sourceLines, sourceSection.startLine, sourceSection.endLine);
	const targetLines = splitLines(targetContent);
	const targetParsed = markdownParser.parseSections(targetContent);
	const insertLine = resolveH1InsertLine(targetLines.length, targetParsed, request);
	const targetNextLines = insertLineRange(targetLines, insertLine, movedBlock);
	return {
		sourceContent: joinLines(sourceNextLines),
		targetContent: joinLines(targetNextLines),
	};
}

function moveH2AcrossContents(
	sourceContent: string,
	targetContent: string,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h2" | "markdown-info-file" }>,
): { sourceContent: string; targetContent: string } | null {
	const sourceLines = splitLines(sourceContent);
	const sourceParsed = markdownParser.parseSections(sourceContent);
	const sourceH1 = sourceParsed.h1Sections[request.sourceH2Node.h1IndexInSource];
	const sourceH2 = sourceH1?.h2Sections[request.sourceH2Node.h2IndexInH1];
	if (!sourceH2) {
		throw new Error("H2 source section not found");
	}

	const movedBlock = sourceLines.slice(sourceH2.startLine, sourceH2.endLine);
	if (movedBlock.length === 0) {
		return null;
	}

	const sourceNextLines = removeLineRange(sourceLines, sourceH2.startLine, sourceH2.endLine);
	const targetLines = splitLines(targetContent);
	const targetParsed = markdownParser.parseSections(targetContent);
	const insertLine = resolveH2InsertLine(targetParsed, request);
	const targetNextLines = insertLineRange(targetLines, insertLine, movedBlock);
	return {
		sourceContent: joinLines(sourceNextLines),
		targetContent: joinLines(targetNextLines),
	};
}

function resolveH1InsertLine(
	contentLineCount: number,
	parsed: ReturnType<GuidebookMarkdownParser["parseSections"]>,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h1" | "subfolder" }>,
): number {
	if (request.position === "inside") {
		return contentLineCount;
	}
	const targetNode = request.targetH1Node;
	if (!targetNode) {
		throw new Error("H1 target not found");
	}
	const targetSection = parsed.h1Sections[targetNode.h1IndexInSource];
	if (!targetSection) {
		throw new Error("H1 target section not found");
	}
	return request.position === "before" ? targetSection.startLine : targetSection.endLine;
}

function resolveH2InsertLine(
	parsed: ReturnType<GuidebookMarkdownParser["parseSections"]>,
	request: Extract<GuidebookTreeDragMoveRequest, { kind: "markdown-h2" | "markdown-info-file" }>,
): number {
	const targetH1 = parsed.h1Sections[request.targetH1Node.h1IndexInSource];
	if (!targetH1) {
		throw new Error("H2 target H1 section not found");
	}
	if (request.position === "inside") {
		return targetH1.endLine;
	}
	const targetNode = request.targetH2Node;
	if (!targetNode) {
		throw new Error("H2 target section not found");
	}
	const targetH2 = targetH1.h2Sections[targetNode.h2IndexInH1];
	if (!targetH2) {
		throw new Error("H2 target section not found");
	}
	return request.position === "before" ? targetH2.startLine : targetH2.endLine;
}

function moveLineRange(lines: string[], startLine: number, endLine: number, insertLine: number): string[] {
	const movedBlock = lines.slice(startLine, endLine);
	if (movedBlock.length === 0) {
		return lines;
	}
	let normalizedInsertLine = clamp(insertLine, 0, lines.length);
	if (normalizedInsertLine > startLine) {
		normalizedInsertLine -= movedBlock.length;
	}
	if (normalizedInsertLine === startLine) {
		return lines;
	}
	const remaining = removeLineRange(lines, startLine, endLine);
	return insertLineRange(remaining, normalizedInsertLine, movedBlock);
}

function removeLineRange(lines: string[], startLine: number, endLine: number): string[] {
	return [...lines.slice(0, startLine), ...lines.slice(endLine)];
}

function insertLineRange(lines: string[], insertLine: number, insertedLines: string[]): string[] {
	const normalizedInsertLine = clamp(insertLine, 0, lines.length);
	return [...lines.slice(0, normalizedInsertLine), ...insertedLines, ...lines.slice(normalizedInsertLine)];
}

function joinLines(lines: string[]): string {
	return lines.join("\n");
}

function resolveCollectionFileByPath(app: App, path: string): TFile | null {
	const file = app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

function collectOrderedCollectionPaths(treeData: GuidebookTreeData | null): string[] {
	if (!treeData) {
		return [];
	}
	const paths: string[] = [];
	for (const fileNode of treeData.files) {
		const path = resolveSingleSourcePath(fileNode);
		if (path) {
			paths.push(path);
		}
	}
	return paths;
}

function resolveSingleSourceCollectionPath(
	context: GuidebookTreeDragSortContext,
	fileNode: GuidebookTreeFileNode,
): string | null {
	const path = resolveSingleSourcePath(fileNode);
	if (path) {
		return path;
	}
	new Notice(context.t("feature.guidebook.notice.collection_multi_source_unsupported"));
	return null;
}

function resolveSingleSourcePath(fileNode: GuidebookTreeFileNode): string | null {
	if (fileNode.sourcePaths.length !== 1) {
		return null;
	}
	return fileNode.sourcePaths[0] ?? null;
}

function movePathInArray(
	paths: string[],
	sourcePath: string,
	targetPath: string,
	position: "before" | "after",
): string[] {
	const next = paths.filter((path) => path !== sourcePath);
	const targetIndex = next.indexOf(targetPath);
	if (targetIndex < 0) {
		next.push(sourcePath);
		return next;
	}
	const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
	next.splice(insertIndex, 0, sourcePath);
	return next;
}






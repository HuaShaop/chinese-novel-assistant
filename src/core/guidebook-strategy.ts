// core/guidebook-strategy.ts

import { App, TFile, TFolder } from "obsidian";
import type {
    GuidebookTreeData,
    GuidebookTreeFileNode,
    GuidebookTreeH1Node,
    GuidebookTreeH2Node,
} from "../features/guidebook/tree-builder";

export interface IGuidebookModelStrategy {
    /** 模型标识，用于 UI 层极少数的差异处理 */
    readonly modelType: "folder" | "heading";

    /** 构建该模型下所有文件节点 */
    buildFileNodes(app: App, rootPath: string): Promise<GuidebookTreeFileNode[]>;

    // --- 集合级操作 ---
    createCollection(app: App, parentPath: string, name: string): Promise<void>;
    renameCollection(app: App, currentPath: string, newName: string): Promise<void>;
    deleteCollection(app: App, path: string): Promise<void>;
    isCollectionNameDuplicate(app: App, parentPath: string, name: string): Promise<boolean>;

    // --- 分类级操作 ---
    createCategory(app: App, parentPath: string, name: string): Promise<void>;
    renameCategory(app: App, currentPath: string, newName: string): Promise<void>;
    deleteCategory(app: App, path: string): Promise<void>;
    isCategoryNameDuplicate(
        app: App, parentPath: string, name: string, ignoreName?: string
    ): Promise<boolean>;

    // --- 设定级操作 ---
    createSetting(app: App, parentPath: string, name: string, template?: string): Promise<void>;
    renameSetting(app: App, currentPath: string, newName: string): Promise<void>;
    deleteSetting(app: App, path: string): Promise<void>;
    isSettingNameDuplicate(
        app: App, parentPath: string, name: string, ignoreName?: string
    ): Promise<boolean>;

    // 可选的辅助方法，用于树节点排序等
    getCollectionStableKey?(app: App, collectionPath: string): Promise<string>;
}
import { TFile, TFolder } from 'obsidian';
import { NOVEL_LIBRARY_SUBDIR_NAMES, NovelLibraryService, PluginContext } from '../../core';
import { logger } from '../../utils/logger';
import { Marker } from './types';

export class MapCache {
    private ctx: PluginContext;
    private libraryService: NovelLibraryService;

    // 缓存数据
    private mapLibPath: string | null = null;
    private imageFiles: TFile[] = [];
    private recentFilePath: string | null = null;
    private isInitialized: boolean = false;
    private markersCache: Map<string, Marker[]> = new Map();

    // 当前选中的文件路径（用于恢复选中状态）
    private selectedPath: string = '';

    constructor(ctx: PluginContext) {
        this.ctx = ctx;
        this.libraryService = new NovelLibraryService(ctx.app);
    }

    /**
     * 初始化缓存：解析路径并扫描目录
     * 若路径未变化且已初始化，则跳过（除非 force 为 true）
     */
    async init(force: boolean = false): Promise<void> {
        const newPath = this.resolveMapLibPath();
        if (!force && newPath === this.mapLibPath && this.isInitialized) {
            return;
        }

        this.mapLibPath = newPath;
        if (!this.mapLibPath) {
            this.imageFiles = [];
            this.isInitialized = true;
            return;
        }

        const folder = this.ctx.app.vault.getAbstractFileByPath(this.mapLibPath);
        if (!folder || !(folder instanceof TFolder)) {
            logger.warn(`目录 "${this.mapLibPath}" 不存在`);
            this.imageFiles = [];
            this.isInitialized = true;
            return;
        }

        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'];
        this.imageFiles = folder.children
            .filter((child): child is TFile => child instanceof TFile)
            .filter(file => imageExtensions.includes(file.extension.toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name));

        this.isInitialized = true;
        this.markersCache.clear();
    }

    /**
     * 刷新缓存：重新读取目录，比较是否有变化
     */
    async refresh(): Promise<boolean> {
        if (!this.mapLibPath) return false;

        const folder = this.ctx.app.vault.getAbstractFileByPath(this.mapLibPath);
        if (!folder || !(folder instanceof TFolder)) {
            this.imageFiles = [];
            return true; // 变化了
        }

        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'];
        const newFiles = folder.children
            .filter((child): child is TFile => child instanceof TFile)
            .filter(file => imageExtensions.includes(file.extension.toLowerCase()))
            .sort((a, b) => a.name.localeCompare(b.name));

        const hasChanged = (() => {
            if (newFiles.length !== this.imageFiles.length) return true;
            for (let i = 0; i < newFiles.length; i++) {
                if (newFiles[i]!.path !== this.imageFiles[i]!.path) return true;
            }
            return false;
        })();

        if (hasChanged) {
            this.imageFiles = newFiles;
        }
        return hasChanged;
    }

    /** 获取当前缓存的图片文件列表 */
    getFiles(): TFile[] {
        return this.imageFiles;
    }

    /** 获取当前地图库路径 */
    getMapLibPath(): string | null {
        return this.mapLibPath;
    }

    /** 设置当前选中的文件路径（用于恢复） */
    setSelectedPath(path: string): void {
        this.selectedPath = path;
    }

    /** 获取当前选中的文件路径 */
    getSelectedPath(): string {
        return this.selectedPath;
    }

    /** 判断某个文件是否位于当前地图库目录内 */
    isFileInMapLib(file: TFile): boolean {
        if (!this.mapLibPath) return false;
        return file.path.startsWith(this.mapLibPath + '/') || file.path === this.mapLibPath;
    }

    /** 检查当前活动文件所属的小说库是否变化，若变化则返回 true */
    checkLibraryChanged(): boolean {
        const newPath = this.resolveMapLibPath();
        return newPath !== this.mapLibPath;
    }

    /**
     * 加载指定图片的标记列表
     * 约定标记文件路径为：图片路径 + '.markers.json'
     */
    async loadMarkers(imagePath: string): Promise<Marker[]> {
        if (this.markersCache.has(imagePath)) {
            return this.markersCache.get(imagePath) || [];
        }
        const markerFilePath = this.getMarkerFilePath(imagePath);
        try {
            const exists = await this.ctx.app.vault.adapter.exists(markerFilePath);
            if (!exists) {
                this.markersCache.set(imagePath, []);
                return [];
            }
            const content = await this.ctx.app.vault.adapter.read(markerFilePath);
            const data = JSON.parse(content);
            const markers = Array.isArray(data) ? data : [];
            this.markersCache.set(imagePath, markers);
            return markers;
        } catch (e) {
            logger.warn(`读取标记文件失败: ${markerFilePath}`, e);
            this.markersCache.set(imagePath, []);
            return [];
        }
    }

    /**
     * 保存指定图片的标记列表
     */
    async saveMarkers(imagePath: string, markers: Marker[]): Promise<void> {
        const markerFilePath = this.getMarkerFilePath(imagePath);
        const content = JSON.stringify(markers, null, 2);
        await this.ctx.app.vault.adapter.write(markerFilePath, content);
        this.markersCache.set(imagePath, markers);
    }

    /**
     * 清除标记缓存（通常在库路径切换时调用）
     */
    clearMarkersCache(): void {
        this.markersCache.clear();
    }

    

    // ==================== 私有方法 ====================
    private resolveMapLibPath(): string | null {
        const { app, settings } = this.ctx;
        const normalizedLibraryRoots = this.libraryService.normalizeLibraryRoots(settings.novelLibraries);
        const activeFilePath = app.workspace.getActiveFile()?.path ?? this.recentFilePath;
        if (activeFilePath && activeFilePath !== this.recentFilePath) {
            this.recentFilePath = activeFilePath;
        }
        const containingLibraryRoot = activeFilePath
            ? this.libraryService.resolveContainingLibraryRoot(activeFilePath, normalizedLibraryRoots)
            : null;
        if (!containingLibraryRoot) {
            return null;
        }
        return this.libraryService.resolveNovelLibrarySubdirPath(
            containingLibraryRoot,
            NOVEL_LIBRARY_SUBDIR_NAMES.mapLibrary
        );
    }
    
    private getMarkerFilePath(imagePath: string): string {
        return imagePath + '.markers.json';
    }
}
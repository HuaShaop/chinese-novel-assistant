import { ItemView, WorkspaceLeaf, Notice, TFile, TFolder, IconName, Menu } from 'obsidian';
import { PluginContext } from '../../core';
import { MapCache } from './map-cache';
import { MapRenderer } from './map-render';
import { Marker } from './types';
import { MarkerModal } from './marker-modal';
import { logger } from '../../utils/logger';

export const MAP_VIEW_TYPE = 'novel-map-view';

export class MapView extends ItemView {
    private cache: MapCache;
    private renderer: MapRenderer;

    private selectEl: HTMLSelectElement | null = null;
    private sliderEl: HTMLInputElement | null = null;
    private canvasEl: HTMLCanvasElement | null = null;
    private libraryNameEl: HTMLElement | null = null;
    private zoomLabelEl: HTMLElement | null = null;

    // 统一拖拽状态
    private dragState = {
        isDragging: false,
        startX: 0,
        startY: 0,
        offsetX: 0,
        offsetY: 0
    };

    // 使用 AbortController 管理 DOM 事件
    private domController: AbortController | null = null;
    private globalDragController: AbortController | null = null;

    private vaultHandler: ((file: TFile | TFolder) => void) | null = null;
    private workspaceHandler: ((leaf: WorkspaceLeaf | null) => void) | null = null;
    private layoutHandler: (() => void) | null = null;

    private refreshPromise: Promise<unknown> | null = null;
    private rootName: string;

    constructor(leaf: WorkspaceLeaf, private readonly ctx: PluginContext) {
        super(leaf);
        this.cache = new MapCache(ctx);
        this.renderer = new MapRenderer(ctx);
    }

    getViewType(): string {
        return MAP_VIEW_TYPE;
    }

    getDisplayText(): string {
        return '小说地图';
    }

    getIcon(): IconName {
        return 'map';
    }

    async onOpen() {
        const container = this.containerEl;
        container.empty();

        this.buildLibraryLabel(container);

        const toolbar = container.createDiv({ cls: 'novel-map-toolbar' });
        this.buildToolbar(toolbar);

        const canvasContainer = container.createDiv({ cls: 'novel-map-canvas-container' });
        this.canvasEl = canvasContainer.createEl('canvas');
        this.renderer.setCanvas(this.canvasEl);
        this.setupCanvasEvents();

        await this.initCache();
        this.registerVaultEvents();
        this.registerWorkspaceEvents();
    }

    async onClose() {
        // 取消所有 DOM 事件
        if (this.domController) {
            this.domController.abort();
            this.domController = null;
        }
        if (this.globalDragController) {
            this.globalDragController.abort();
            this.globalDragController = null;
        }

        // 清理 Obsidian 事件
        if (this.vaultHandler) {
            const vault = this.ctx.app.vault;
            vault.off('create', this.vaultHandler);
            vault.off('delete', this.vaultHandler);
            vault.off('rename', this.vaultHandler);
            this.vaultHandler = null;
        }
        if (this.workspaceHandler) {
            this.ctx.app.workspace.off('active-leaf-change', this.workspaceHandler);
            this.workspaceHandler = null;
        }
        if (this.layoutHandler) {
            this.ctx.app.workspace.off('layout-change', this.layoutHandler);
            this.layoutHandler = null;
        }

        // 取消可能正在进行的刷新
        this.refreshPromise = null;
        this.renderer.clear();
        this.dragState.isDragging = false;
    }

    // ==================== UI 构建 ====================
    private buildToolbar(container: HTMLElement) {
        this.buildSelect(container);
        this.buildZoomControls(container);
        this.buildActionButtons(container);
    }

    private buildSelect(container: HTMLElement) {
        const select = container.createEl('select', { cls: 'map-select' });
        select.style.width = '200px';
        this.selectEl = select;
        select.addEventListener('change', () => {
            const val = select.value;
            if (!val) return;
            this.cache.setSelectedPath(val);
            this.loadImageByPath(val);
        });
    }

    private buildZoomControls(container: HTMLElement) {
        // 工厂函数创建按钮
        const createZoomButton = (text: string, delta: number) => {
            const btn = container.createEl('button', { text, cls: 'map-zoom-btn' });
            btn.addEventListener('click', () => {
                if (!this.sliderEl) return;
                let newVal = parseInt(this.sliderEl.value) + delta;
                newVal = Math.max(20, Math.min(300, newVal));
                this.sliderEl.value = String(newVal);
                this.applyScale(parseInt(this.sliderEl.value) / 100);
            });
            return btn;
        };

        createZoomButton('−', -5);

        const zoomLabel = container.createEl('span', { cls: 'map-zoom-label' });
        zoomLabel.textContent = '100%';
        this.zoomLabelEl = zoomLabel;

        const slider = container.createEl('input', {
            type: 'range',
            cls: 'map-zoom-slider',
            attr: { min: '20', max: '300', step: '5', value: '100' }
        });
        this.sliderEl = slider;
        slider.addEventListener('input', () => {
            this.applyScale(parseInt(slider.value) / 100);
        });

        createZoomButton('+', 5);
    }

    private buildActionButtons(container: HTMLElement) {
        const createActionButton = (text: string, cls: string, onClick: () => void) => {
            const btn = container.createEl('button', { text, cls });
            btn.addEventListener('click', onClick);
            return btn;
        };

        createActionButton('⟲', 'map-reset-btn', () => {
            this.renderer.resetTransform();
            const currentScale = this.renderer.getScale();
            if (this.sliderEl) {
                this.sliderEl.value = String(Math.round(currentScale * 100));
            }
            this.updateZoomLabel(currentScale);
        });

        createActionButton('🔍', 'map-filter-btn', () => {
            new Notice('筛选功能暂未实现');
        });

        createActionButton('↻', 'map-refresh-btn', async () => {
            await this.initCache(true);
            new Notice('地图列表已刷新');
        });
    }

    private buildLibraryLabel(container: HTMLElement) {
        const libraryLabel = container.createEl('div', { cls: 'map-library-label' });
        libraryLabel.textContent = '未激活小说库';
        this.libraryNameEl = libraryLabel;
    }

    // ==================== 缓存与 UI 同步 ====================
    private async initCache(force: boolean = false) {
        await this.withRefreshLock(() => this.doInitCache(force));
        this.updateLibraryInfo();
    }

    private async doInitCache(force: boolean) {
        await this.cache.init(force);
        if (!this.cache.getMapLibPath()) {
            this.renderer.showEmptyState('未找到地图库，请确保当前笔记位于小说库中');
        }
        this.updateDropdown();
    }

    private async refreshCache() {
        if (!this.cache.getMapLibPath()) return;
        const changed = await this.withRefreshLock(() => this.cache.refresh());
        if (changed) this.updateDropdown();
    }

    private updateDropdown() {
        const select = this.selectEl;
        if (!select) return;

        const files = this.cache.getFiles();
        select.empty();

        if (files.length === 0) {
            select.disabled = true;
            const option = select.createEl('option');
            option.textContent = '没有可用图片';
            option.value = '';
            select.appendChild(option);
            this.renderer.showEmptyState('请将图片放入 "_功能库" 目录');
            return;
        }

        files.forEach(file => {
            const option = select.createEl('option');
            option.value = file.path;
            option.textContent = file.basename;
            select.appendChild(option);
        });

        let valueToSet = this.cache.getSelectedPath();
        if (!valueToSet || !files.some(f => f.path === valueToSet)) {
            valueToSet = files[0]!.path;
        }
        select.value = valueToSet;
        select.disabled = false;
        this.cache.setSelectedPath(valueToSet);
        this.loadImageByPath(valueToSet);
        this.updateLibraryInfo();
    }

    private updateLibraryInfo() {
        if (!this.libraryNameEl) return;
        const mapLibPath = this.cache.getMapLibPath();
        if (!mapLibPath) {
            this.libraryNameEl.textContent = '未激活小说库';
            return;
        }
        const parts = mapLibPath.split('/');
        this.rootName = parts.length >= 1 ? parts[0]! : mapLibPath;
        this.libraryNameEl.textContent = `${this.rootName}`;
    }

    private updateZoomLabel(scale: number) {
        if (!this.zoomLabelEl) return;
        this.zoomLabelEl.textContent = `${Math.round(scale * 100)}%`;
    }

    // ==================== 图片加载 ====================
    private async loadImageByPath(path: string) {
        const file = this.ctx.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            new Notice('文件不存在');
            return;
        }
        const markers = await this.cache.loadMarkers(path);
        this.renderer.setMarkers(markers);
        this.renderer.loadImage(file);
        this.updateZoomLabel(this.renderer.getScale());
        if (this.sliderEl) {
            this.sliderEl.value = String(Math.round(this.renderer.getScale() * 100));
        }
    }

    // ==================== 交互处理 ====================
    private screenToImageCoords(mouseX: number, mouseY: number): { x: number; y: number } {
        const offsetX = this.renderer.getOffsetX();
        const offsetY = this.renderer.getOffsetY();
        const scale = this.renderer.getScale();
        return { x: (mouseX - offsetX) / scale, y: (mouseY - offsetY) / scale };
    }

    private applyScale(scale: number) {
        this.renderer.setScale(scale);
        if (this.sliderEl) {
            this.sliderEl.value = String(Math.round(scale * 100));
        }
        this.updateZoomLabel(scale);
    }

    private findMarkerAtScreenPos(mouseX: number, mouseY: number): { marker: Marker; index: number } | null {
        if (!this.renderer.hasImage()) return null;
        const offsetX = this.renderer.getOffsetX();
        const offsetY = this.renderer.getOffsetY();
        const scale = this.renderer.getScale();
        const markers = this.renderer.getMarkers();

        for (let i = 0; i < markers.length; i++) {
            const m = markers[i];
            if (!m) continue;
            const screenX = offsetX + m.x * scale;
            const screenY = offsetY + m.y * scale;
            const dx = mouseX - screenX;
            const dy = mouseY - screenY;
            if (dx * dx + dy * dy < 100) {
                return { marker: m, index: i };
            }
        }
        return null;
    }

    private handleContextMenu(clientX: number, clientY: number) {
        const rect = this.canvasEl?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = clientX - rect.left;
        const mouseY = clientY - rect.top;
        const hit = this.findMarkerAtScreenPos(mouseX, mouseY);
        const currentPath = this.cache.getSelectedPath();
        if (!currentPath) return;

        const menu = new Menu();
        if (hit) {
            menu.addItem(item => item
                .setTitle('编辑标记')
                .setIcon('pencil')
                .onClick(() => this.editMarker(hit.index, hit.marker, currentPath))
            );
            menu.addItem(item => item
                .setTitle('删除标记')
                .setIcon('trash')
                .onClick(() => this.deleteMarker(hit.index, currentPath))
            );
        } else {
            menu.addItem(item => item
                .setTitle('添加标记')
                .setIcon('plus')
                .onClick(() => this.createMarker(mouseX, mouseY, currentPath))
            );
        }
        menu.showAtPosition({ x: clientX, y: clientY });
    }

    private handleMarkerClick(mouseX: number, mouseY: number) {
        const hit = this.findMarkerAtScreenPos(mouseX, mouseY);
        if (hit && hit.marker.link) {
            this.ctx.app.workspace.openLinkText(hit.marker.link, this.cache.getMapLibPath() || '');
        }
    }

    private async createMarker(mouseX: number, mouseY: number, imagePath: string) {
        const { x: imgX, y: imgY } = this.screenToImageCoords(mouseX, mouseY);
        const modal = new MarkerModal(this.ctx.app, this.rootName, '添加标记');
        modal.open();
        const result = await modal.waitForResult();
        if (!result) return;

        const markers = this.renderer.getMarkers();
        const newMarker: Marker = {
            id: Date.now().toString(),
            x: imgX,
            y: imgY,
            label: result.label,
            link: result.link,
            color: result.color
        };
        markers.push(newMarker);
        await this.cache.saveMarkers(imagePath, markers);
        this.renderer.setMarkers(markers);
    }

    private async editMarker(index: number, marker: Marker, imagePath: string) {
        const modal = new MarkerModal(
            this.ctx.app,
            this.rootName,
            '编辑标记',
            marker.label || '',
            marker.link || '',
            marker.color || '#e74c3c'
        );
        modal.open();
        const result = await modal.waitForResult();
        if (!result) return;

        const markers = this.renderer.getMarkers();
        markers[index] = {
            ...marker,
            label: result.label,
            link: result.link || undefined,
            color: result.color
        };
        await this.cache.saveMarkers(imagePath, markers);
        this.renderer.setMarkers(markers);
    }

    private async deleteMarker(index: number, imagePath: string) {
        const markers = this.renderer.getMarkers();
        markers.splice(index, 1);
        await this.cache.saveMarkers(imagePath, markers);
        this.renderer.setMarkers(markers);
    }

    // ==================== Canvas 事件拆分 ====================
    private setupCanvasEvents() {
        if (!this.canvasEl) return;

        // 创建控制器用于 canvas 自身事件
        this.domController = new AbortController();
        const signal = this.domController.signal;

        this.setupWheel(signal);
        this.setupDrag(signal);
        this.setupContextMenu(signal);
        this.setupClick(signal);
        this.setupResize(signal);
    }

    private setupWheel(signal: AbortSignal) {
        if (!this.canvasEl) return;
        this.canvasEl.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const rect = this.canvasEl!.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.renderer.zoomAt(mouseX, mouseY, delta);
            this.applyScale(this.renderer.getScale());
        }, { signal, passive: false });
    }

    private setupDrag(signal: AbortSignal) {
        if (!this.canvasEl) return;

        // 本地 mousedown
        this.canvasEl.addEventListener('mousedown', (e: MouseEvent) => {
            if (e.button !== 0 || !this.renderer.hasImage()) return;
            const rect = this.canvasEl!.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top || e.clientY > rect.bottom) return;

            this.dragState.isDragging = true;
            this.dragState.startX = e.clientX;
            this.dragState.startY = e.clientY;
            this.dragState.offsetX = this.renderer.getOffsetX();
            this.dragState.offsetY = this.renderer.getOffsetY();
            e.preventDefault();

            // 创建全局拖拽控制器（每次拖拽重新创建，确保只有一个）
            if (this.globalDragController) {
                this.globalDragController.abort();
            }
            this.globalDragController = new AbortController();
            const globalSignal = this.globalDragController.signal;

            // 全局 mousemove
            document.addEventListener('mousemove', (moveEv: MouseEvent) => {
                if (!this.dragState.isDragging) return;
                const dx = moveEv.clientX - this.dragState.startX;
                const dy = moveEv.clientY - this.dragState.startY;
                this.renderer.setOffset(
                    this.dragState.offsetX + dx,
                    this.dragState.offsetY + dy
                );
            }, { signal: globalSignal });

            // 全局 mouseup
            document.addEventListener('mouseup', () => {
                if (!this.dragState.isDragging) return;
                this.dragState.isDragging = false;
                // 清理全局控制器
                if (this.globalDragController) {
                    this.globalDragController.abort();
                    this.globalDragController = null;
                }
            }, { signal: globalSignal, once: true });
        }, { signal });
    }

    private setupContextMenu(signal: AbortSignal) {
        if (!this.canvasEl) return;
        this.canvasEl.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            this.handleContextMenu(e.clientX, e.clientY);
        }, { signal });
    }

    private setupClick(signal: AbortSignal) {
        if (!this.canvasEl) return;
        this.canvasEl.addEventListener('click', (e: MouseEvent) => {
            if (this.dragState.isDragging) return;
            const rect = this.canvasEl!.getBoundingClientRect();
            this.handleMarkerClick(e.clientX - rect.left, e.clientY - rect.top);
        }, { signal });
    }

    private setupResize(signal: AbortSignal) {
        window.addEventListener('resize', () => {
            requestAnimationFrame(() => this.renderer.redraw());
        }, { signal });
    }

    // ==================== 异步锁 ====================
    private async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
        if (this.refreshPromise) {
            // 等待当前锁完成，并返回其结果（不重新执行）
            return this.refreshPromise as Promise<T>;
        }
        const promise = fn();
        this.refreshPromise = promise;
        try {
            return await promise;
        } finally {
            if (this.refreshPromise === promise) {
                this.refreshPromise = null;
            }
        }
    }

    // ==================== 事件注册 ====================
    private registerVaultEvents() {
        const vault = this.ctx.app.vault;
        const handler = (file: TFile | TFolder) => {
            if (file instanceof TFile && this.cache.isFileInMapLib(file)) {
                this.refreshCache();
            }
        };
        this.vaultHandler = handler;
        vault.on('create', handler);
        vault.on('delete', handler);
        vault.on('rename', handler);
    }

    private registerWorkspaceEvents() {
        const handler = (leaf: WorkspaceLeaf | null) => {
            if (leaf?.view === this && this.cache.checkLibraryChanged()) {
                this.initCache(true);
            }
        };
        this.workspaceHandler = handler;
        this.ctx.app.workspace.on('active-leaf-change', handler);

        const layoutHandler = () => {
            if (this.canvasEl) {
                requestAnimationFrame(() => {
                    this.renderer.redraw();
                });
            }
        };
        this.layoutHandler = layoutHandler;
        this.ctx.app.workspace.on('layout-change', layoutHandler);
    }
}
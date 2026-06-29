import { ItemView, WorkspaceLeaf, Notice, TFile, TFolder } from 'obsidian';
import { PluginContext } from '../../core';
import { MapCache } from './map-cache';
import { MapRenderer } from './map-render';

export const MAP_VIEW_TYPE = 'novel-map-view';

export class MapView extends ItemView {
    // 核心模块
    private cache: MapCache;
    private renderer: MapRenderer;

    // DOM 元素
    private selectEl: HTMLSelectElement | null = null;
    private sliderEl: HTMLInputElement | null = null;
    private canvasEl: HTMLCanvasElement | null = null;
    private libraryNameEl: HTMLElement | null = null;
    private zoomLabelEl: HTMLElement | null = null;
    // 拖拽状态
    private isDragging: boolean = false;
    private dragStartX: number = 0;
    private dragStartY: number = 0;
    private dragStartOffsetX: number = 0;
    private dragStartOffsetY: number = 0;
    // 事件处理器引用（用于清理）
    private vaultHandler: ((file: TFile | TFolder) => void) | null = null;
    private workspaceHandler: ((leaf: WorkspaceLeaf | null) => void) | null = null;
    private boundWheelHandler: ((e: WheelEvent) => void) | null = null;
    private boundOnMouseDown: ((e: MouseEvent) => void) | null = null;
    private boundOnMouseMove: ((e: MouseEvent) => void) | null = null;
    private boundOnMouseUp: ((e: MouseEvent) => void) | null = null;
    // 刷新锁
    private refreshPromise: Promise<void> | null = null;

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

    async onOpen() {
        const container = this.containerEl;
        container.empty();

        // 创建工具栏
        const toolbar = container.createDiv({ cls: 'novel-map-toolbar' });
        this.buildToolbar(toolbar);

        // 创建画布容器
        const canvasContainer = container.createDiv({ cls: 'novel-map-canvas-container' });
        this.canvasEl = canvasContainer.createEl('canvas');
        this.renderer.setCanvas(this.canvasEl);
        this.boundWheelHandler = (e: WheelEvent) => {
            e.preventDefault(); // 阻止页面滚动
            const rect = this.canvasEl!.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            // 滚轮向下（deltaY > 0）缩小，向上放大
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.renderer.zoomAt(mouseX, mouseY, delta);

            // 同步缩放滑块
            const newScale = this.renderer.getScale();
            if (this.sliderEl) {
                this.sliderEl.value = String(Math.round(newScale * 100));
            }
            this.updateZoomLabel(newScale);
        };
        this.canvasEl.addEventListener('wheel', this.boundWheelHandler);

        // 鼠标按下事件
        this.boundOnMouseDown = (e: MouseEvent) => {
            // 只响应左键
            if (e.button !== 0) return;
            // 没有图片时不处理
            if (!this.renderer.hasImage()) return;

            const rect = this.canvasEl!.getBoundingClientRect();
            // 检查鼠标是否在画布区域内
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top || e.clientY > rect.bottom) {
                return;
            }

            this.isDragging = true;
            this.dragStartX = e.clientX;
            this.dragStartY = e.clientY;
            this.dragStartOffsetX = this.renderer.getOffsetX();
            this.dragStartOffsetY = this.renderer.getOffsetY();

            this.canvasEl!.style.cursor = 'grabbing';
            e.preventDefault();

            // 在全局监听鼠标移动和释放
            document.addEventListener('mousemove', this.boundOnMouseMove!);
            document.addEventListener('mouseup', this.boundOnMouseUp!);
        };
        this.canvasEl.addEventListener('mousedown', this.boundOnMouseDown);

        // 鼠标移动事件
        this.boundOnMouseMove = (e: MouseEvent) => {
            if (!this.isDragging) return;
            const dx = e.clientX - this.dragStartX;
            const dy = e.clientY - this.dragStartY;
            this.renderer.setOffset(
                this.dragStartOffsetX + dx,
                this.dragStartOffsetY + dy
            );
        };

        // 鼠标释放事件
        this.boundOnMouseUp = (e: MouseEvent) => {
            if (!this.isDragging) return;
            this.isDragging = false;
            this.canvasEl!.style.cursor = 'grab';
            document.removeEventListener('mousemove', this.boundOnMouseMove!);
            document.removeEventListener('mouseup', this.boundOnMouseUp!);
        };

        // 初始化缓存
        await this.initCache();
        // 注册事件
        this.registerVaultEvents();
        this.registerWorkspaceEvents();
    }

    async onClose() {
        // 移除事件监听
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
        // 清理渲染器
        this.renderer.clear();
        if (this.boundWheelHandler && this.canvasEl) {
            this.canvasEl.removeEventListener('wheel', this.boundWheelHandler);
            this.boundWheelHandler = null;
        }
        // 移除 mousedown 监听
        if (this.boundOnMouseDown && this.canvasEl) {
            this.canvasEl.removeEventListener('mousedown', this.boundOnMouseDown);
            this.boundOnMouseDown = null;
        }

        // 清理可能残留的全局监听
        if (this.boundOnMouseMove) {
            document.removeEventListener('mousemove', this.boundOnMouseMove);
            this.boundOnMouseMove = null;
        }
        if (this.boundOnMouseUp) {
            document.removeEventListener('mouseup', this.boundOnMouseUp);
            this.boundOnMouseUp = null;
        }
        this.isDragging = false;
    }

    // ==================== UI 构建 ====================
    private buildToolbar(container: HTMLElement) {
        // 下拉菜单
        const select = container.createEl('select', { cls: 'map-select' });
        select.style.width = '200px';
        this.selectEl = select;
        select.addEventListener('change', () => {
            const val = select.value;
            if (!val) return;
            this.cache.setSelectedPath(val);
            this.loadImageByPath(val);
        });

        // 缩小按钮
        const zoomOutBtn = container.createEl('button', { text: '−', cls: 'map-zoom-btn' });
        zoomOutBtn.addEventListener('click', () => {
            if (this.sliderEl) {
                let newVal = parseInt(this.sliderEl.value) - 5;
                if (newVal < 20) newVal = 20;
                this.sliderEl.value = String(newVal);
                this.sliderEl.dispatchEvent(new Event('input'));
            }
        });
        //百分比标签
        const zoomLabel = container.createEl('span', { cls: 'map-zoom-label' });
        zoomLabel.textContent = '100%';
        this.zoomLabelEl = zoomLabel;
        // 缩放滑块
        const slider = container.createEl('input', {
            type: 'range',
            cls: 'map-zoom-slider',
            attr: { min: '20', max: '300', step: '5', value: '100' }
        });
        this.sliderEl = slider;
        slider.addEventListener('input', () => {
            const scale = parseInt(slider.value) / 100;
            this.renderer.setScale(scale);
            this.updateZoomLabel(scale);
        });

        // 放大按钮
        const zoomInBtn = container.createEl('button', { text: '+', cls: 'map-zoom-btn' });
        zoomInBtn.addEventListener('click', () => {
            if (this.sliderEl) {
                let newVal = parseInt(this.sliderEl.value) + 5;
                if (newVal > 300) newVal = 300;
                this.sliderEl.value = String(newVal);
                this.sliderEl.dispatchEvent(new Event('input'));
            }
        });

        // 重置按钮
        const resetBtn = container.createEl('button', { text: '⟲', cls: 'map-reset-btn' });
        resetBtn.addEventListener('click', () => {
            this.renderer.resetTransform();
            if (this.sliderEl) {
                this.sliderEl.value = '100';
            }
            this.updateZoomLabel(1);
        });

        // 筛选按钮（占位）
        const filterBtn = container.createEl('button', { text: '🔍', cls: 'map-filter-btn' });
        filterBtn.addEventListener('click', () => {
            new Notice('筛选功能暂未实现');
        });

        // 手动刷新按钮
        const refreshBtn = container.createEl('button', { text: '↻', cls: 'map-refresh-btn' });
        refreshBtn.addEventListener('click', async () => {
            await this.initCache(true);
            new Notice('地图列表已刷新');
        });

        const libraryLabel = container.createEl('span', { cls: 'map-library-label' });
        libraryLabel.textContent = '库: 未激活'; // 占位
        this.libraryNameEl = libraryLabel;
    }

    // ==================== 缓存与 UI 同步 ====================
    private async initCache(force: boolean = false) {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }
        this.refreshPromise = this.doInitCache(force);
        try {
            await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
        this.updateLibraryInfo();
    }

    private async doInitCache(force: boolean) {
        await this.cache.init(force);
        if (!this.cache.getMapLibPath()) {
            // 无法定位地图库，显示通用提示
            this.renderer.showEmptyState('未找到地图库，请确保当前笔记位于小说库中');
        }
        this.updateDropdown();
    }

    private async refreshCache() {
        if (!this.cache.getMapLibPath()) return;
        if (this.refreshPromise) {
            await this.refreshPromise;
            return;
        }
        const changed = await this.cache.refresh();
        if (changed) {
            this.updateDropdown();
        }
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

        // 恢复选中状态
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
            this.libraryNameEl.textContent = '库: 未激活';
            return;
        }
        // 假设 mapLibPath 格式为 "库根目录/_功能库"，我们取第一级目录名
        const parts = mapLibPath.split('/');
        if (parts.length >= 1) {
            const rootName = parts[0]; // 或使用 NovelLibraryService 获取更友好的名称
            this.libraryNameEl.textContent = `库: ${rootName}`;
        } else {
            this.libraryNameEl.textContent = `库: ${mapLibPath}`;
        }
    }

    private updateZoomLabel(scale: number) {
        if (!this.zoomLabelEl) return;
        const percent = Math.round(scale * 100);
        this.zoomLabelEl.textContent = `${percent}%`;
    }
    // ==================== 图片加载 ====================
    private loadImageByPath(path: string) {
        const file = this.ctx.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            new Notice('文件不存在');
            return;
        }

        if (this.sliderEl) {
            this.sliderEl.value = '100';
        }
        this.updateZoomLabel(1);
        this.renderer.loadImage(file);
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
            if (leaf?.view === this) {
                // 检测小说库是否变化
                if (this.cache.checkLibraryChanged()) {
                    this.initCache(true); // 强制刷新
                }
            }
        };
        this.workspaceHandler = handler;
        this.ctx.app.workspace.on('active-leaf-change', handler);
    }
}
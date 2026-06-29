import { TFile } from 'obsidian';
import { PluginContext } from '../../core';

export class MapRenderer {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private image: HTMLImageElement | null = null;
    private scale: number = 1;
    private offsetX: number = 0;
    private offsetY: number = 0;

    constructor(private readonly appContext: PluginContext) { }

    /** 绑定 Canvas 元素 */
    setCanvas(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    /** 加载图片文件到 Canvas */
    loadImage(file: TFile): void {
        const url = this.appContext.app.vault.getResourcePath(file);
        const img = new Image();
        img.onload = () => {
            this.image = img;
            this.scale = 1;
            if (this.canvas) {
                this.offsetX = (this.canvas.width - img.width) / 2;
                this.offsetY = (this.canvas.height - img.height) / 2;
            }
            this.redraw();
        };
        img.onerror = () => {
            // 由调用方处理错误通知
            this.image = null;
            this.redraw();
        };
        img.src = url;
    }

    /** 设置缩放比例（0.2 ~ 3.0） */
    setScale(newScale: number): void {
        if (!this.canvas || !this.image) return;
        const clamped = Math.min(3.0, Math.max(0.2, newScale));
        if (clamped === this.scale) return;

        // 围绕画布中心缩放
        const cx = this.canvas.width / 2;
        const cy = this.canvas.height / 2;
        const imgX = (cx - this.offsetX) / this.scale;
        const imgY = (cy - this.offsetY) / this.scale;

        this.scale = clamped;
        this.offsetX = cx - imgX * this.scale;
        this.offsetY = cy - imgY * this.scale;
        this.redraw();
    }

    /** 获取当前缩放比例 */
    getScale(): number {
        return this.scale;
    }

    /** 重绘画布 */
    redraw(): void {
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!canvas || !ctx) return;

        // 调整画布大小以适应容器
        const container = canvas.parentElement;
        if (container) {
            const rect = container.getBoundingClientRect();
            canvas.width = rect.width || 800;
            canvas.height = rect.height || 600;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (this.image) {
            ctx.save();
            ctx.translate(this.offsetX, this.offsetY);
            ctx.scale(this.scale, this.scale);
            ctx.drawImage(this.image, 0, 0);
            ctx.restore();
        }
    }

    /** 清空画布 */
    clear(): void {
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this.image = null;
    }

    zoomAt(mouseX: number, mouseY: number, factor: number): void {
        if (!this.image) return;

        const oldScale = this.scale;
        let newScale = oldScale * factor;
        // 限制缩放范围
        if (newScale > 3.0) newScale = 3.0;
        if (newScale < 0.2) newScale = 0.2;
        if (newScale === oldScale) return;

        // 计算鼠标位置在图片坐标系中的坐标（世界坐标）
        const imgX = (mouseX - this.offsetX) / oldScale;
        const imgY = (mouseY - this.offsetY) / oldScale;

        // 更新缩放值
        this.scale = newScale;
        // 调整偏移量，使得同一世界坐标 (imgX, imgY) 重新映射到鼠标位置 (mouseX, mouseY)
        this.offsetX = mouseX - imgX * newScale;
        this.offsetY = mouseY - imgY * newScale;

        this.redraw();
    }

    resetTransform(): void {
        if (!this.canvas || !this.image) return;
        this.scale = 1;
        // 重新居中图片
        this.offsetX = (this.canvas.width - this.image.width) / 2;
        this.offsetY = (this.canvas.height - this.image.height) / 2;
        this.redraw();
    }
    /** 获取当前加载的图片对象（用于外部检测） */
    hasImage(): boolean {
        return this.image !== null;
    }
    
    getOffsetX(): number {
        return this.offsetX;
    }

    getOffsetY(): number {
        return this.offsetY;
    }

    // 设置偏移量（直接赋值，触发重绘）
    setOffset(x: number, y: number): void {
        this.offsetX = x;
        this.offsetY = y;
        this.redraw();
    }

    showEmptyState(message: string): void {
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!canvas || !ctx) return;

        // 调整画布尺寸（与 redraw 逻辑一致）
        const container = canvas.parentElement;
        if (container) {
            const rect = container.getBoundingClientRect();
            canvas.width = rect.width || 800;
            canvas.height = rect.height || 600;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#666';
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(message, canvas.width / 2, canvas.height / 2);
    }
}
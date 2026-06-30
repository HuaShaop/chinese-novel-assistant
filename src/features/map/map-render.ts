import { TFile } from 'obsidian';
import { PluginContext } from '../../core';
import { Marker } from './types';
export class MapRenderer {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private image: HTMLImageElement | null = null;
    private scale: number = 1;
    private offsetX: number = 0;
    private offsetY: number = 0;
    private markers: Marker[] = [];
    private readonly max_scale: number = 3.0;
    private readonly min_scale: number = 0.2;

    constructor(private readonly appContext: PluginContext) { }

    /** 绑定 Canvas 元素 */
    setCanvas(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    setMarkers(markers: Marker[]): void {
        this.markers = markers || [];
        this.redraw();
    }

    getMarkers(): Marker[] {
        return this.markers;
    }

    /** 加载图片文件到 Canvas */
    loadImage(file: TFile): void {
        const url = this.appContext.app.vault.getResourcePath(file);
        const img = new Image();
        img.onload = () => {
            this.image = img;
            this.applyFitToCanvas();
        };
        img.onerror = () => {
            // 由调用方处理错误通知
            this.image = null;
            this.redraw();
        };
        img.src = url;
    }

    /** 设置缩放比例（this.min_scale ~ this.max_scale） */
    setScale(newScale: number): void {
        if (!this.canvas || !this.image) return;
        const clamped = Math.min(this.max_scale, Math.max(this.min_scale, newScale));
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

    private applyFitToCanvas(): void {
        if (!this.canvas || !this.image) return;
        const cw = this.canvas.width, ch = this.canvas.height;
        let fitScale = Math.min(cw / this.image.width, ch / this.image.height);
        fitScale = Math.min(3.0, Math.max(0.2, fitScale));
        this.scale = fitScale;
        this.offsetX = (cw - this.image.width * fitScale) / 2;
        this.offsetY = (ch - this.image.height * fitScale) / 2;
        this.redraw();
    }

    /** 重绘画布 */
    redraw(): void {
        const canvas = this.canvas;
        const ctx = this.ctx;
        if (!canvas || !ctx) return;

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

        if (this.image && this.markers.length > 0) {
            const { offsetX, offsetY, scale } = this;
            for (const marker of this.markers) {
                const screenX = offsetX + marker.x * scale;
                const screenY = offsetY + marker.y * scale;

                ctx.beginPath();
                ctx.arc(screenX, screenY, 5, 0, Math.PI * 2);
                ctx.fillStyle = marker.color || '#e74c3c';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                ctx.stroke();

                if (marker.label) {
                    const fontSize = 14;
                    ctx.font = `bold ${fontSize}px '楷体', 'KaiTi', serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillStyle = '#222222';
                    ctx.fillText(marker.label, screenX, screenY - 10);
                }
            }
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
        if (newScale > this.max_scale) newScale = this.max_scale;
        if (newScale < this.min_scale) newScale = this.min_scale;
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
        this.applyFitToCanvas();
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
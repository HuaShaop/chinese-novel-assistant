export interface Marker {
    id: string;          // 唯一标识(时间戳)
    x: number;           // 图片坐标系 X
    y: number;           // 图片坐标系 Y
    label?: string;      // 可选标签文字
    type?: string;       // 可选类型
    color?: string;      // 可选颜色
    link?: string;       // 文件链接
}
import { MapMarkerType } from "../../core/custom-type-config";
export interface MarkerFormData extends MapMarkerType {
    label: string;
    link: string;
}

export interface Marker extends MarkerFormData {
    id: string;          // 唯一标识(时间戳)
    x: number;           // 图片坐标系 X
    y: number;           // 图片坐标系 Y
}
import { App, Plugin } from "obsidian";
import { MAP_VIEW_TYPE, MapView } from "./map-view";
import { PluginContext } from "../../core";

export function registerMapView(plugin: Plugin, ctx: PluginContext) {
    plugin.registerView(MAP_VIEW_TYPE, (leaf) => new MapView(leaf, ctx));
}

export async function activateMapView(plugin: Plugin, ctx: PluginContext) {
    const { workspace } = plugin.app;
    let leaf = workspace.getLeavesOfType(MAP_VIEW_TYPE)[0];
    if (!leaf) {
        leaf = workspace.getLeaf(true);
        await leaf.setViewState({ type: MAP_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
}
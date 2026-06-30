import { type AbstractInputSuggest, type App, TFile } from "obsidian";
import { attachInputSuggest } from "./input-suggest";

export interface MarkdownSuggestOptions {
    shouldIncludeFilePath?: (path: string) => boolean;
}

export function attachMarkdownSuggest(
    app: App,
    inputEl: HTMLInputElement,
    options?: MarkdownSuggestOptions,
): AbstractInputSuggest<TFile> {
    return attachInputSuggest<TFile>({
        app,
        inputEl,
        limit: 100,
        minSuggestionsToShow: 1,
        getSuggestions: (query: string) => {
            const normalized = query.trim().toLowerCase();
            const files = app.vault
                .getAllLoadedFiles()
                .filter(
                    (file): file is TFile =>
                        file instanceof TFile &&
                        file.extension === "md" &&
                        (options?.shouldIncludeFilePath?.(file.path) ?? true),
                );

            if (!normalized) {
                return files.slice(0, 100);
            }

            return files.filter((file) => file.path.toLowerCase().includes(normalized)).slice(0, 100);
        },
        renderSuggestion: (file: TFile, el: HTMLElement) => {
            el.setText(file.path);
        },
        getSuggestionValue: (file: TFile) => file.path,
    });
}
export const TEMPLATES: Record<string, string> = {
    "变动模板": `---
tags:
  - change
entity: "[["
attribute:
old:
new:
date:
description:
vol_idx:
chpt_idx:
---
# {{title}}
## 详情
（可详细描述事件经过、原因、影响）`,
    "地点模板": `---
aliases:
cssclasses:
  - location-class
tags:
  - location
parent: "[["
type:
---
# {{title}}
## 简要描述`,
    "纠错模板": `小说 _占位_
鲲 _占位_
弩 _占位_`,
    "片段模板": `---
cssclasses:
tags:
  - snippet
---
## pzh
——
## slh
……
## point
·`,
    "人物模板": `---
aliases:
cssclasses:
  - character-class
tags:
  - character
name:
gender:
birthday:
---
# {{title}}
## 简要描述
## 外貌
## 性格
## 能力
## 背景
## 目标
## 人物关系
## 习惯或癖好
`,
    "设定模板": `---
cssclasses:
  - others-class
tags:
  - others
---
# {{title}}`,
    "势力模板": `---
aliases:
cssclasses:
  - faction-class
tags:
  - faction
founder: "[["
headquarters: "[["
---
# {{title}}
## 简要描述
## 特点
## 目标
## 组织架构
## 历史沿革
## 外交关系
`,
    "章节模板": `---
cssclasses:
  - chapter-class
tags:
  - chapter
vol_idx:
chpt_idx:
synopsis:
---
`,
}
export const PROJECT_OVERVIEW_NAME = "_project";
export const PROJECT_OVERVIEW_CONTENT = [
  '---',
  'cssclasses:',
  '  - wide-page',
  '---',
  '',
  '# 📊 工程总览',
  '',
  '```dataviewjs',
  '// 获取仓库信息',
  'const vault = dv.app.vault;',
  'const adapter = vault.adapter;',
  'const basePath = adapter.basePath;  // 本地仓库根目录路径',
  '',
  '// 获取所有笔记文件（.md）',
  'const allFiles = vault.getMarkdownFiles();',
  'const totalFiles = allFiles.length;',
  '',
  '// 获取所有文件夹（不含根目录）',
  'const allFolders = vault.getAllFolders();',
  'const totalFolders = allFolders.length;',
  '',
  '// 获取所有标签（基于所有笔记的内容扫描）',
  'const allTags = dv.page("").file.tags;  // 简单方式，可能不全',
  '// 更精确的标签统计：从所有页面收集',
  'let tagsMap = new Map();',
  'for (let page of dv.pages()) {',
  '    if (page.file.tags) {',
  '        for (let tag of page.file.tags) {',
  '            tagsMap.set(tag, (tagsMap.get(tag) || 0) + 1);',
  '        }',
  '    }',
  '}',
  'const totalUniqueTags = tagsMap.size;',
  '',
  '// 获取总字数（所有笔记的字符数/字数）',
  'let totalChars = 0;',
  'for (let file of allFiles) {',
  '    const content = await vault.cachedRead(file);',
  '    totalChars += content.length;',
  '}',
  'const totalWords = totalChars / 5;  // 粗略估算，中文字符数≈字数',
  '',
  '// 获取最近修改的文件（前5个）',
  'const recentFiles = allFiles',
  '    .sort((a, b) => b.stat.mtime - a.stat.mtime)',
  '    .slice(0, 5);',
  '',
  '// 当前时间',
  'const now = new Date();',
  'const timeStr = now.toLocaleString(\'zh-CN\', { hour12: false });',
  '',
  '// 输出表格样式',
  'dv.span(`',
  '<div style="display: flex; flex-wrap: wrap; gap: 1.5rem; margin-bottom: 2rem;">',
  '    <div style="background: var(--background-secondary); padding: 1rem; border-radius: 12px; min-width: 150px;">',
  '        <div style="font-size: 0.85rem; opacity: 0.7;">📁 仓库路径</div>',
  '        <div style="font-weight: bold; word-break: break-all;">${basePath}</div>',
  '    </div>',
  '    <div style="background: var(--background-secondary); padding: 1rem; border-radius: 12px;">',
  '        <div style="font-size: 0.85rem; opacity: 0.7;">🕒 当前时间</div>',
  '        <div style="font-weight: bold;">${timeStr}</div>',
  '    </div>',
  '    <div style="background: var(--background-secondary); padding: 1rem; border-radius: 12px;">',
  '        <div style="font-size: 0.85rem; opacity: 0.7;">📄 总文件数</div>',
  '        <div style="font-weight: bold;">${totalFiles}</div>',
  '    </div>',
  '    <div style="background: var(--background-secondary); padding: 1rem; border-radius: 12px;">',
  '        <div style="font-size: 0.85rem; opacity: 0.7;">🗂️ 总文件夹数</div>',
  '        <div style="font-weight: bold;">${totalFolders}</div>',
  '    </div>',
  '    <div style="background: var(--background-secondary); padding: 1rem; border-radius: 12px;">',
  '        <div style="font-size: 0.85rem; opacity: 0.7;">🏷️ 唯一标签数</div>',
  '        <div style="font-weight: bold;">${totalUniqueTags}</div>',
  '    </div>',
  '    <div style="background: var(--background-secondary); padding: 1rem; border-radius: 12px;">',
  '        <div style="font-size: 0.85rem; opacity: 0.7;">📝 总字符数</div>',
  '        <div style="font-weight: bold;">${totalChars.toLocaleString()}</div>',
  '    </div>',
  '</div>',
  '`);',
  '',
  '// 最近修改的文件列表',
  'dv.header(3, "🕒 最近修改的文件");',
  'dv.table(',
  '    ["文件名", "路径", "修改时间"],',
  '    recentFiles.map(file => [',
  '        file.basename,',
  '        file.path,',
  '        new Date(file.stat.mtime).toLocaleString(\'zh-CN\')',
  '    ])',
  ');',
  '',
  '// 可选：常用标签云（前15个）',
  'dv.header(3, "🏷️ 常用标签");',
  'const sortedTags = Array.from(tagsMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15);',
  'if (sortedTags.length) {',
  '    dv.span(sortedTags.map(([tag, count]) => `<span style="background: var(--tag-background); padding: 0.2rem 0.6rem; border-radius: 12px; margin: 0.2rem; display: inline-block;">${tag} (${count})</span>`).join(\' \'));',
  '} else {',
  '    dv.span("暂无标签");',
  '}',
  '',
  '// 附加信息：当前打开的笔记（可选）',
  'const activeFile = dv.app.workspace.getActiveFile();',
  'if (activeFile) {',
  '    dv.paragraph(`📖 **当前打开**：${activeFile.basename} （路径：${activeFile.path}）`);',
  '}',
  '```',
  '---',
  '```dataviewjs',
  'const entityName = "林玄";      // 要查询的人物/势力/地点',
  'const attribute = "affiliation"; // 要查询的属性',
  '',
  'const pages = dv.pages(\'"变动库"\')',
  '    .where(p => p.entity === entityName && p.attribute === attribute)',
  '    .sort(p => p.chapter, \'desc\');',
  '',
  'if (pages.length === 0) {',
  '    dv.paragraph(`未找到 ${entityName} 的 ${attribute} 变更记录。`);',
  '} else {',
  '    const latest = pages[0];',
  '    dv.paragraph(`**${entityName}** 当前的 **${attribute}** 是：**${latest.to}** （第 ${latest.chapter} 章发生）`);',
  '}',
  '```'
].join('\n');

# CSV Table Editor

在 VS Code 内打开并编辑 CSV 和 TSV。使用 **Reopen Editor With…** 可以在 **CSV Table Editor** 和 **Text Editor** 之间切换。

## 编辑和查看

- 第一条记录是表头。双击数据单元格编辑，按 Enter 提交，按 Shift+Enter 插入换行，按 Esc 放弃当前输入。提交后的编辑使用 VS Code 原生保存、撤销和重做。
- 点击行号或单元格选中数据行，点击表头选中列。工具栏可以添加或删除行列、重命名列，以及冻结从左侧到选中列的列。
- 点击表头排序图标切换排序，在其下方输入筛选词。排序、筛选、冻结和列宽调整只影响当前视图。
- 使用工具栏的 **Delimiter** 或命令 **CSV Table Editor: Select Delimiter** 切换分隔符。自动识别不明确时，CSV 回退到逗号，TSV 回退到制表符。手动选择按文件记忆，自定义分隔符接受单个字符。

| 快捷键 | 表格操作 |
| --- | --- |
| Alt+Shift+↑ / ↓ | 上移或下移选中的数据行。排序或筛选生效时禁用。 |
| Alt+Shift+← / → | 左移或右移选中的列。 |

## Git 变更

左侧标记和右侧概览尺显示相对 HEAD 的工作区变更。绿色代表新增，蓝色代表修改，红色代表删除边界。已跟踪文件保存后刷新标记，避免将磁盘差异的行号用于未保存的内容。内置 Git 扩展报告为未跟踪的文件会将每条记录标为新增。

## 开发工作流

1. 在项目窗口按 **F5**（**Run Extension**）。VS Code 会运行 `watch` 任务，并行启动 `npm run watch:esbuild` 和 `npm run watch:tsc`。首次编译和类型检查结束后打开 Extension Development Host，监听任务继续运行。
2. 修改 `src/webview/body.html`、`src/webview/styles.css` 或 Webview TypeScript 后保存，等 esbuild 终端出现 `[watch] build finished`。在 **Extension Development Host** 的命令面板执行 **Developer: Reload Webview**。
3. 修改 Extension Host 代码后保存，等待同一构建提示，再在 **Extension Development Host** 执行 **Developer: Restart Extension Host**。用 **Developer: Toggle Developer Tools** 检查 Webview 的 DOM、CSS 和控制台。

只需监听时，可以在项目窗口运行 **Tasks: Run Task → watch**，后续按 F5 会复用该任务启动的监听进程。也可以在独立终端运行 `npm run watch`，此时请先按 Ctrl+C 停止该命令，再用 F5 启动 VS Code 的监听任务。

esbuild 监听入口及其导入的资源。新增 Webview 静态资源时，从 Webview TypeScript 或 CSS 引入，并按文件类型配置 loader。修改 `esbuild.js` 后，重启监听任务以应用新配置。

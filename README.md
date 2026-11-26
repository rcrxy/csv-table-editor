# CSV Table Editor

在 VS Code 内打开并编辑 CSV 和 TSV。使用 **Reopen Editor With…** 可以在 **CSV Table Editor** 和 **Text Editor** 之间切换。

## 编辑和查看

- 默认使用第一条记录作为表头。单击数据单元格选中，双击进入编辑。提交后的编辑使用 VS Code 原生保存、撤销和重做。
- 数据单元格默认单行显示，超出列宽时显示省略号。点击编辑器右上角的换行按钮，可切换为按列宽换行并自动增高。编辑时，输入框始终保持当前列宽，并随内容换行增高。
- 点击行号或单元格选中数据行，点击表头选中列。工具栏可以添加或删除行列、重命名列，以及冻结从左侧到选中列的列。
- 点击表头排序图标切换排序，在其下方输入筛选词。排序、筛选、冻结和列宽调整只影响当前视图。
- 使用工具栏的 **Delimiter** 或命令 **CSV Table Editor: Select Delimiter** 切换分隔符。自动识别不明确时，CSV 回退到逗号，TSV 回退到制表符。手动选择按文件记忆，自定义分隔符接受单个字符。

| 快捷键 | 表格操作 |
| --- | --- |
| ↑ / ↓ / ← / → | 在当前表格视图中移动单元格选区。 |
| Enter | 进入单元格编辑。编辑中按下则插入换行。 |
| Ctrl+Enter | 提交当前单元格编辑并保存文件，选中下一行的同列单元格。 |
| Shift+Enter | 编辑时插入换行。 |
| Esc | 放弃当前单元格编辑。 |
| Alt+↑ / ↓ | 上移或下移当前单元格所在的数据行。排序或筛选生效时禁用。 |
| Alt+← / → | 左移或右移当前单元格所在的列。 |

移动行列时，先选中一个数据单元格。上下移行沿用 VS Code 的原生命令，左右移列可在「键盘快捷方式」中分别改键。

- 右键点击数据单元格或序列号列，可以在对应数据行的上方或下方插入空行。右键点击数据单元格或表头，可以在对应列的左侧或右侧插入空列。插入位置以源文件顺序为准。
- 右键点击序列号列可删除该行。隐藏序列号列后，在第一列的数据单元格中删除行。
- 右键点击表头可删除该列。关闭首条记录作表头后，在排序和筛选后的第一条数据行中删除列。表格至少保留一列。
- 右键选择「清空缓存并重新打开」，会清除当前文件保存的列宽和手动分隔符，并重新打开表格。有未保存内容时，可选择「保存」「不保存」或「取消」。

## 设置

- `csv-table-editor.cellMaxCell` 控制打开文件时自动计算列宽的像素上限，默认 400。自动列宽取前 100 条数据中该列最宽的内容。手动调整过的列宽按文件保存，下次打开时优先恢复。更改上限后重新打开文件即可应用到自动列宽。
- `csv-table-editor.tableHeader` 控制第一条记录是否用于表头，默认开启。关闭后使用 `Column 1` 等列名，第一条记录出现在数据区。已打开的表格会随设置更新。
- `csv-table-editor.showRowNumbers` 控制左侧序列号列是否显示，默认开启。该列显示每条记录在源文件中的起始行号，已打开的表格会随设置更新。

## Git 变更

左侧标记和右侧概览尺显示当前文档相对 HEAD 的变更。绿色代表新增，蓝色代表修改，红色代表删除边界。未保存的编辑也会参与比较。内置 Git 扩展报告为未跟踪的文件会将每条记录标为新增。

## 开发工作流

1. 在项目窗口按 **F5**（**Run Extension**）。VS Code 会运行 `watch` 任务，并行启动 `npm run watch:esbuild` 和 `npm run watch:tsc`。首次编译和类型检查结束后打开 Extension Development Host，监听任务继续运行。
2. 修改 `src/webview/body.html`、`src/webview/styles.css` 或 Webview TypeScript 后保存，等 esbuild 终端出现 `[watch] build finished`。在 **Extension Development Host** 的命令面板执行 **Developer: Reload Webview**。
3. 修改 Extension Host 代码后保存，等待同一构建提示，再在 **Extension Development Host** 执行 **Developer: Restart Extension Host**。用 **Developer: Toggle Developer Tools** 检查 Webview 的 DOM、CSS 和控制台。

只需监听时，可以在项目窗口运行 **Tasks: Run Task → watch**，后续按 F5 会复用该任务启动的监听进程。也可以在独立终端运行 `npm run watch`，此时请先按 Ctrl+C 停止该命令，再用 F5 启动 VS Code 的监听任务。

esbuild 监听入口及其导入的资源。新增 Webview 静态资源时，从 Webview TypeScript 或 CSS 引入，并按文件类型配置 loader。修改 `esbuild.js` 后，重启监听任务以应用新配置。

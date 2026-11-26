# CSV Table Editor

在 VS Code 中以表格形式查看和编辑 CSV、TSV 文件。编辑会同步到 VS Code 文档，可使用原生保存、撤销和重做。

## 安装和打开

支持 VS Code 1.x，最低版本为 1.146.0。扩展 ID 为 `zeco.csv-table-editor`。

1. 拿到 `.vsix` 文件后，在扩展视图右上角的菜单选择 **从 VSIX 安装…**，并选中该文件。 [VS Code 安装说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
2. 打开 `.csv` 或 `.tsv` 文件。需要切换视图时，右键点击编辑器标签页并选择 **Reopen Editor With…**，然后选 **CSV Table Editor** 或 **Text Editor**。

## 编辑和查看

- 默认使用第一条记录作为表头。单击数据单元格选中，双击进入编辑。点击行号可选中数据行，点击表头可选中列。
- 数据单元格默认单行显示，超出列宽时显示省略号。点击编辑器右上角的换行按钮，可切换为按列宽换行并自动增高。编辑时，输入框始终保持当前列宽，并随内容换行增高。
- 表格按源文件中的记录顺序显示。拖动表头分隔线可以调整列宽，调整后的列宽按文件保存。

| 快捷键 | 表格操作 |
| --- | --- |
| ↑ / ↓ / ← / → | 在当前表格视图中移动单元格选区。 |
| Enter | 进入单元格编辑。编辑中按下则插入换行。 |
| Ctrl+Enter | 提交当前单元格编辑并保存文件，选中下一行的同列单元格。 |
| Esc | 放弃当前单元格编辑。 |
| Alt+↑ / ↓ | 上移或下移当前单元格所在的数据行。 |
| Alt+← / → | 左移或右移当前单元格所在的列。 |

移动行列时，先选中一个数据单元格。上下移行沿用 VS Code 的原生命令，左右移列可在「键盘快捷方式」中分别改键。

## 右键菜单

- 右键点击数据单元格并选择「编辑单元格」，即可修改该单元格的内容。
- 右键点击数据单元格或序列号列，可以在对应数据行的上方或下方插入空行。右键点击数据单元格或表头，可以在对应列的左侧或右侧插入空列。插入位置以源文件顺序为准。
- 右键点击序列号列可删除该行。隐藏序列号列后，在第一列的数据单元格中删除行。
- 右键点击表头可删除该列。关闭首条记录作表头后，在当前视图的第一条数据行中删除列。表格至少保留一列。
- 右键选择「清空缓存并重新打开」，会清除当前文件保存的列宽和手动分隔符，并重新打开表格。有未保存内容时，可选择「保存」「不保存」或「取消」。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `csv-table-editor.cellMaxCell` | `400` | 自动列宽的像素上限。打开文件时根据前 100 条数据估算列宽，优先恢复手动调整过的宽度。修改上限后重新打开文件即可应用。 |
| `csv-table-editor.tableHeader` | `true` | 使用第一条记录作为表头。关闭后第一条记录显示在数据区，列名使用 `Column 1` 等默认名称。设置即时生效。 |
| `csv-table-editor.showRowNumbers` | `true` | 显示每条记录在源文件中的起始行号。设置即时生效。 |

在命令面板运行 **CSV 表格编辑器：选择分隔符**（**CSV Table Editor: Select Delimiter**），可以恢复自动识别、选择常见分隔符，或输入一个自定义分隔字符。自动识别不明确时，`.csv` 使用逗号，`.tsv` 使用制表符。手动选择会在当前工作区内按文件记忆。

## Git 变更

内置 Git 扩展识别到当前文件所在的仓库后，左侧行号列和右侧纵向滚动条会显示文档相对 `HEAD` 的变更。绿色代表新增，蓝色代表修改，红色代表删除边界。点击滚动条上的标记可跳转到对应记录。未保存的编辑也会参与比较，未跟踪的文件会将每条记录标为新增。

## 开发工作流

克隆本仓库后，在项目根目录运行 `npm ci` 安装依赖。

1. 在项目窗口按 **F5**（**Run Extension**）。VS Code 会运行 `watch` 任务，并行启动 `npm run watch:esbuild` 和 `npm run watch:tsc`。首次编译和类型检查结束后打开 Extension Development Host，监听任务继续运行。
2. 修改 `src/webview/body.html`、`src/webview/styles.css` 或 Webview TypeScript 后保存，等 esbuild 终端出现 `[watch] build finished`。在 **Extension Development Host** 的命令面板执行 **Developer: Reload Webview**。
3. 修改 Extension Host 代码后保存，等待同一构建提示，再在 **Extension Development Host** 执行 **Developer: Restart Extension Host**。用 **Developer: Toggle Developer Tools** 检查 Webview 的 DOM、CSS 和控制台。

只需监听时，可以在项目窗口运行 **Tasks: Run Task → watch**，后续按 F5 会复用该任务启动的监听进程。也可以在独立终端运行 `npm run watch`，此时请先按 Ctrl+C 停止该命令，再用 F5 启动 VS Code 的监听任务。

esbuild 监听入口及其导入的资源。新增 Webview 静态资源时，从 Webview TypeScript 或 CSS 引入，并按文件类型配置 loader。修改 `esbuild.js` 后，重启监听任务以应用新配置。

## 打包

安装项目依赖后，在项目根目录运行：

```sh
npm run package:vsix
```

命令按需获取官方 `@vscode/vsce`，执行现有生产构建，并在项目根目录生成 `csv-table-editor-<版本>.vsix`。运行依赖由 esbuild 打入构建产物。 [VS Code 打包说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions)

## 许可证

本项目由 zeco 开发，采用 MIT 许可证。 [LICENSE](LICENSE) · [第三方许可声明](THIRD-PARTY-NOTICES.txt)

# CSV Table Editor

## 硬约束（优先级最高，与下文任何内容冲突时以本节为准）

- 不写测试。禁止创建任何测试文件（`*.test.ts`、`*.spec.ts`、`__tests__/`、`test/`、`fixtures/` 等），禁止安装测试框架或运行器（vitest、jest、mocha、@vscode/test-electron、playwright 等），禁止运行测试或覆盖率命令。
- 不做过度验证。代码改完后不要主动执行类型检查、ESLint、构建、打包、F5 调试、截图比对或任何端到端验证。一次任务内，除用户明确要求，不执行 `npm run compile`、`npm run format:check`。
- 验证归用户。agent 的交付标准是「代码写完 + 改动范围说明清楚」，不包含「已通过验证」。不得为了验证而新增脚本、临时文件或依赖。
- 不谎报。未实际执行过的检查，不得写成「已测试」「已验证」。需要用户确认时，用一句话点明验证点即可。

## 项目现状

- 本项目是 VS Code 扩展，目标是在 VS Code 内将 CSV 和 TSV 文件解析并呈现为表格。
- `package.json` 声明自定义文本编辑器和分隔符命令。`src/extension.ts` 是扩展宿主入口，由 `esbuild.js` 构建为 `dist/extension.js`。
- `src/core/` 处理解析和文本编辑。`src/editor/` 负责文档同步和 Webview 配置。`src/git/` 通过 VS Code 内置 Git 扩展生成变更标记。`src/webview/` 使用 Tabulator 呈现表格，独立构建为 `dist/webview.js` 和 `dist/webview.css`。

## 开发约定

- 使用 TypeScript 严格模式。修改扩展命令或编辑器注册时，同步核对 `package.json` 中对应的贡献点。
- 使用 Papa Parse 解析 CSV/TSV，显式区分逗号和制表符，保留引号内的分隔符、换行、空字段和前导零。使用 Tabulator 在 VS Code Webview 中呈现表格。
- 由扩展宿主处理 VS Code API 和文件操作。Webview 负责表格渲染和交互，通过消息与扩展宿主通信。将表格单元格内容按文本渲染。
- 只使用项目内已声明的 npm 依赖，不新增依赖（构建工具链除外且需先说明）。`dist/` 和 `out/` 由构建生成，不手改。

## 格式与验证

- 禁止打包进入测试产物。
- 代码格式以 `.prettierrc.json` 为准：3 空格缩进、LF、双引号、语句末尾分号。写代码时直接照此风格输出，不要靠事后跑 formatter 纠正。
- ESLint 配置在 `eslint.config.mjs`，它只是写代码时的风格参照，不需要每次执行。
- `npm run compile`（类型检查 + ESLint + 构建）、`npm run watch`、`npm run format` 都是给用户手动使用的脚本，agent 仅在用户本次任务明确要求时运行其中一个。
- 界面或扩展行为的验证，由用户按 F5 在 Extension Development Host 手动完成；agent 不自行启动 VS Code、不写验证脚本、不模拟点击。

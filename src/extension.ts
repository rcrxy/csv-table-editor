import * as vscode from "vscode";
import { CsvTableEditorProvider, viewType } from "./editor/CsvTableEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
   const provider = new CsvTableEditorProvider(context);
   context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(viewType, provider, {
         webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand("csv-table-editor.selectDelimiter", () => provider.selectDelimiter()),
   );
}

import * as vscode from "vscode";
import { CsvTableEditorProvider, viewType } from "./editor/CsvTableEditorProvider";
import type { TableDirection } from "./shared/messages";

export function activate(context: vscode.ExtensionContext): void {
   const provider = new CsvTableEditorProvider(context);
   context.subscriptions.push(
      provider,
      vscode.window.registerCustomEditorProvider(viewType, provider, {
         webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand("csv-table-editor.selectDelimiter", () => provider.selectDelimiter()),
      vscode.commands.registerCommand("csv-table-editor.toggleTextWrapping", (resource?: vscode.Uri) =>
         provider.toggleTextWrapping(resource),
      ),
      vscode.commands.registerCommand("csv-table-editor.editCell", (context?: unknown) => provider.editCell(context)),
      vscode.commands.registerCommand("csv-table-editor.deleteRow", (context: unknown) =>
         provider.deleteFromMenu("deleteRow", context),
      ),
      vscode.commands.registerCommand("csv-table-editor.deleteColumn", (context: unknown) =>
         provider.deleteFromMenu("deleteColumn", context),
      ),
      vscode.commands.registerCommand("csv-table-editor.moveCellSelection", (direction: unknown) => {
         if (isTableDirection(direction)) {
            provider.runTableAction({ kind: "moveCellSelection", direction });
         }
      }),
      vscode.commands.registerCommand("csv-table-editor.moveColumnLeft", () =>
         provider.runTableAction({ kind: "moveTableStructure", direction: "left" }),
      ),
      vscode.commands.registerCommand("csv-table-editor.moveColumnRight", () =>
         provider.runTableAction({ kind: "moveTableStructure", direction: "right" }),
      ),
      vscode.commands.registerCommand("csv-table-editor.submitCellEdit", (save?: boolean) =>
         provider.runTableAction({ kind: "submitCellEdit", save: save === true }),
      ),
   );
}

function isTableDirection(value: unknown): value is TableDirection {
   return value === "up" || value === "down" || value === "left" || value === "right";
}

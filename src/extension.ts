import * as vscode from "vscode";
import { CsvTableEditorProvider, viewType } from "./editor/CsvTableEditorProvider";
import type { TableDirection } from "./shared/messages";

const structureMenuCommands = [
   "insertRowAbove",
   "insertRowBelow",
   "insertColumnLeft",
   "insertColumnRight",
   "deleteRow",
   "deleteColumn",
   "freezeCell",
   "unfreezeCell",
] as const;

export function activate(context: vscode.ExtensionContext): void {
   const provider = new CsvTableEditorProvider(context);
   context.subscriptions.push(
      provider,
      vscode.window.registerCustomEditorProvider(viewType, provider, {
         webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand("delimgrid.selectDelimiter", () => provider.selectDelimiter()),
      vscode.commands.registerCommand("delimgrid.clearAndReloadTable", () =>
         provider.runTableAction({ kind: "prepareCacheReload" }),
      ),
      vscode.commands.registerCommand("delimgrid.toggleTextWrapping", (resource?: vscode.Uri) =>
         provider.toggleTextWrapping(resource),
      ),
      vscode.commands.registerCommand("delimgrid.editCell", (context?: unknown) =>
         provider.runCellAction("editCell", context),
      ),
      vscode.commands.registerCommand("delimgrid.clearCell", (context?: unknown) =>
         provider.runCellAction("clearCell", context),
      ),
      vscode.commands.registerCommand("delimgrid.copyTableRange", (context: unknown) =>
         provider.clipboardFromMenu("copy", context),
      ),
      vscode.commands.registerCommand("delimgrid.pasteTableColumn", (context: unknown) =>
         provider.clipboardFromMenu("paste", context),
      ),
      ...structureMenuCommands.map((command) =>
         vscode.commands.registerCommand(`delimgrid.${command}`, (context: unknown) =>
            provider.editStructureFromMenu(command, context),
         ),
      ),
      vscode.commands.registerCommand("delimgrid.moveCellSelection", (direction: unknown) => {
         if (isTableDirection(direction)) {
            provider.runTableAction({ kind: "moveCellSelection", direction });
         }
      }),
      vscode.commands.registerCommand("delimgrid.moveColumnLeft", () =>
         provider.runTableAction({ kind: "moveTableStructure", direction: "left" }),
      ),
      vscode.commands.registerCommand("delimgrid.moveColumnRight", () =>
         provider.runTableAction({ kind: "moveTableStructure", direction: "right" }),
      ),
      vscode.commands.registerCommand("delimgrid.submitCellEdit", (save?: boolean) =>
         provider.runTableAction({ kind: "submitCellEdit", save: save === true }),
      ),
      vscode.commands.registerCommand("delimgrid.cancelCellEdit", () => provider.runTableAction({ kind: "cancelCellEdit" })),
      vscode.commands.registerCommand("delimgrid.undoCellEdit", () =>
         provider.runTableAction({ kind: "editCellHistory", command: "undo" }),
      ),
      vscode.commands.registerCommand("delimgrid.redoCellEdit", () =>
         provider.runTableAction({ kind: "editCellHistory", command: "redo" }),
      ),
      vscode.commands.registerCommand("delimgrid.insertCellLineBreak", () =>
         provider.runTableAction({ kind: "insertCellLineBreak" }),
      ),
   );
}

function isTableDirection(value: unknown): value is TableDirection {
   return value === "up" || value === "down" || value === "left" || value === "right";
}

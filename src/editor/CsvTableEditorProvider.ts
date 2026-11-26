import * as vscode from "vscode";
import { delimiters, delimiterError, detectDelimiter, parseDocument, type ParsedDocument } from "../core/CsvParser";
import { documentEdits } from "../core/DocumentEdits";
import { GitGutter } from "../git/GitGutter";
import type {
   HostMessage,
   KeyboardMode,
   Operation,
   Snapshot,
   StructureMenuCommand,
   TableAction,
   WebviewMessage,
} from "../shared/messages";
import { configureWebview } from "./webview";

export const viewType = "csv-table-editor.table";

const nativeMoveLineCommands = [
   ["editor.action.moveLinesUpAction", "up"],
   ["editor.action.moveLinesDownAction", "down"],
] as const;

export class CsvTableEditorProvider implements vscode.CustomTextEditorProvider {
   private readonly sessions = new Set<DocumentController>();
   private keyboardMode: KeyboardMode = "inactive";
   private canMoveTableStructure = false;
   private moveLineHandlers: vscode.Disposable | undefined;

   constructor(private readonly context: vscode.ExtensionContext) {}

   dispose(): void {
      this.moveLineHandlers?.dispose();
   }

   resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
      const session = new DocumentController(this.context, document, panel, () => this.updateKeyboardContext());
      this.sessions.add(session);
      panel.onDidChangeViewState(() => this.updateKeyboardContext());
      panel.onDidDispose(() => {
         this.sessions.delete(session);
         this.updateKeyboardContext();
      });
      this.updateKeyboardContext();
   }

   runTableAction(action: TableAction): void {
      const session = this.activeSession();
      if (session && (action.kind !== "moveTableStructure" || session.canMoveTableStructure)) {
         session.runTableAction(action);
      }
   }

   editCell(context: unknown): void {
      if (context === undefined) {
         this.runTableAction({ kind: "editCell" });
         return;
      }
      if (
         !isRecord(context) ||
         context.webview !== viewType ||
         context.webviewSection !== "cell" ||
         typeof context.field !== "string" ||
         !/^c\d+$/.test(context.field)
      ) {
         return;
      }
      const { rowId, revision, version } = context;
      if (typeof rowId === "number" && typeof revision === "number" && typeof version === "number") {
         this.runTableAction({
            kind: "editCell",
            target: { row: rowId, column: Number(context.field.slice(1)), revision, version },
         });
      }
   }

   editStructureFromMenu(command: StructureMenuCommand, context: unknown): void {
      const session = this.activeSession();
      if (
         !session ||
         !isRecord(context) ||
         context.webview !== viewType ||
         context.tableResource !== session.document.uri.toString()
      ) {
         return;
      }
      if (
         (command === "deleteRow" && context.canDeleteTableRow !== true) ||
         (command === "deleteColumn" && context.canDeleteTableColumn !== true)
      ) {
         return;
      }
      const { field, rowId, revision, version } = context;
      if (
         (field === undefined || (typeof field === "string" && /^(_line|c\d+)$/.test(field))) &&
         (rowId === undefined || (typeof rowId === "number" && Number.isSafeInteger(rowId))) &&
         typeof revision === "number" &&
         typeof version === "number"
      ) {
         session.runTableAction({ kind: "editStructureFromMenu", command, target: { field, rowId, revision, version } });
      }
   }

   private activeSession(): DocumentController | undefined {
      return [...this.sessions].find(({ panel }) => panel.active);
   }

   private updateKeyboardContext(): void {
      const session = this.activeSession();
      const mode = session?.keyboardMode ?? "inactive";
      if (mode !== this.keyboardMode) {
         this.keyboardMode = mode;
         void vscode.commands.executeCommand("setContext", "csvTableEditor.keyboardMode", mode);
      }
      const canMove = session?.canMoveTableStructure ?? false;
      if (canMove === this.canMoveTableStructure) {
         return;
      }
      this.canMoveTableStructure = canMove;
      if (canMove) {
         this.moveLineHandlers = this.registerMoveLineHandlers();
      }
      void vscode.commands.executeCommand("setContext", "csvTableEditor.canMoveTableStructure", canMove);
      if (!canMove) {
         this.moveLineHandlers?.dispose();
         this.moveLineHandlers = undefined;
      }
   }

   private registerMoveLineHandlers(): vscode.Disposable {
      const handlers: vscode.Disposable[] = [];
      // 工作台会优先派发给最后注册的同名处理器，释放后恢复内置处理器。
      for (const [command, direction] of nativeMoveLineCommands) {
         try {
            handlers.push(
               vscode.commands.registerCommand(command, () => this.runTableAction({ kind: "moveTableStructure", direction })),
            );
         } catch (error) {
            console.warn(`Could not handle ${command} in CSV Table Editor.`, error);
         }
      }
      return vscode.Disposable.from(...handlers);
   }

   toggleTextWrapping(resource?: vscode.Uri): void {
      const session = [...this.sessions].find(({ document, panel }) =>
         resource ? document.uri.toString() === resource.toString() : panel.active,
      );
      session?.toggleTextWrapping();
   }

   async selectDelimiter(): Promise<void> {
      const session = this.activeSession();
      if (session) {
         await session.selectDelimiter();
      } else {
         void vscode.window.showInformationMessage("Open a CSV or TSV file in CSV Table Editor first.");
      }
   }
}

class DocumentController {
   keyboardMode: KeyboardMode = "inactive";
   private hasSelectedCell = false;
   private readonly delimiterKey: string;
   private readonly columnWidthsKey: string;
   private readonly fallback: string;
   private readonly cellMaxWidth: number;
   private manualDelimiter: string | undefined;
   private autoDelimiter: string | undefined;
   private parsed: ParsedDocument | undefined;
   private snapshot!: Snapshot;
   private ready = false;
   private disposed = false;
   private editing = false;
   private reloading = false;
   private pickingDelimiter = false;
   private textWrapping = false;
   private readonly git: GitGutter;

   constructor(
      private readonly context: vscode.ExtensionContext,
      readonly document: vscode.TextDocument,
      readonly panel: vscode.WebviewPanel,
      private readonly onKeyboardModeChange: () => void,
   ) {
      this.delimiterKey = `delimiter:${document.uri.toString()}`;
      this.columnWidthsKey = `columnWidths:${document.uri.toString()}`;
      this.fallback = document.uri.path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
      const config = vscode.workspace.getConfiguration("csv-table-editor", document.uri);
      const width = Math.floor(config.get<number>("cellMaxCell", 400));
      this.cellMaxWidth = Number.isSafeInteger(width) && width > 0 ? width : 400;
      const saved = context.workspaceState.get<string>(this.delimiterKey);
      this.manualDelimiter = saved && !delimiterError(saved) ? saved : undefined;
      this.updateSnapshot();
      this.git = new GitGutter(document, () => ({ parsed: this.parsed, revision: this.snapshot.revision }), (message) => {
         this.post(message);
      });
      const subscriptions = [
         this.git,
         panel.webview.onDidReceiveMessage((message: unknown) => {
            if (isWebviewMessage(message)) {
               void this.receive(message);
            }
         }),
         vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document === document) {
               this.sync();
               this.git.schedule();
            }
         }),
         vscode.workspace.onDidSaveTextDocument((savedDocument) => {
            if (savedDocument === document) {
               this.git.schedule();
            }
         }),
         vscode.workspace.onDidChangeConfiguration((event) => {
            if (
               event.affectsConfiguration("csv-table-editor.tableHeader", document.uri) ||
               event.affectsConfiguration("csv-table-editor.showRowNumbers", document.uri)
            ) {
               this.sync(true);
            }
         }),
         panel.onDidDispose(() => {
            this.disposed = true;
            subscriptions.forEach((subscription) => subscription.dispose());
         }),
      ];
      configureWebview(panel.webview, context.extensionUri);
   }

   toggleTextWrapping(): void {
      this.textWrapping = !this.textWrapping;
      this.post({ type: "textWrapping", enabled: this.textWrapping });
   }

   runTableAction(action: TableAction): void {
      this.post({ type: "tableAction", action });
   }

   get canMoveTableStructure(): boolean {
      return this.keyboardMode === "grid" && this.hasSelectedCell;
   }

   private async clearAndReload(): Promise<void> {
      const tabs = vscode.window.tabGroups;
      const tab = tabs.activeTabGroup.activeTab;
      const uri = this.document.uri;
      if (
         this.reloading ||
         this.editing ||
         this.disposed ||
         !this.panel.active ||
         !(tab?.input instanceof vscode.TabInputCustom) ||
         tab.input.viewType !== viewType ||
         tab.input.uri.toString() !== uri.toString()
      ) {
         return;
      }

      this.reloading = true;
      try {
         if (this.document.isDirty && !(await this.confirmReload(tab))) {
            return;
         }
         if (!this.isActiveTab(tab) || this.document.isDirty) {
            return;
         }
         const options = { viewColumn: tab.group.viewColumn, preview: tab.isPreview };
         if (!(await tabs.close(tab))) {
            return;
         }
         try {
            const state = this.context.workspaceState;
            await Promise.all([state.update(this.delimiterKey, undefined), state.update(this.columnWidthsKey, undefined)]);
         } finally {
            await vscode.commands.executeCommand("vscode.openWith", uri, viewType, options);
         }
      } catch (failure) {
         const message = failure instanceof Error ? failure.message : String(failure);
         void vscode.window.showErrorMessage(vscode.l10n.t("Could not clear the table cache and reopen: {0}", message));
      } finally {
         this.reloading = false;
      }
   }

   private async confirmReload(tab: vscode.Tab): Promise<boolean> {
      const version = this.document.version;
      const save = { title: vscode.l10n.t("Save") };
      const discard = { title: vscode.l10n.t("Don't Save") };
      const cancel = { title: vscode.l10n.t("Cancel"), isCloseAffordance: true };
      const choice = await vscode.window.showWarningMessage(
         vscode.l10n.t("Save changes to {0} before reopening the table?", tab.label),
         {
            modal: true,
            detail: vscode.l10n.t("The current file's saved column widths and delimiter will be cleared when the table reopens."),
         },
         save,
         discard,
         cancel,
      );
      if ((choice !== save && choice !== discard) || !this.isActiveTab(tab)) {
         return false;
      }
      if (!this.document.isDirty) {
         return true;
      }
      if (choice === save) {
         if (!(await this.document.save())) {
            throw new Error(vscode.l10n.t("VS Code could not save this file."));
         }
      } else {
         // 原生还原命令优先处理有焦点的编辑器列表，因此先聚焦当前表格所在的编辑器组。
         await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
         if (!this.isActiveTab(tab)) {
            return false;
         }
         if (this.document.version !== version) {
            throw new Error(vscode.l10n.t("The file changed while the dialog was open. Review the changes and try again."));
         }
         await vscode.commands.executeCommand("workbench.action.files.revert");
         if (this.document.isDirty) {
            throw new Error(vscode.l10n.t("VS Code could not discard the unsaved changes."));
         }
      }
      return !this.document.isDirty;
   }

   private isActiveTab(tab: vscode.Tab): boolean {
      return !this.disposed && this.panel.active && vscode.window.tabGroups.activeTabGroup.activeTab === tab;
   }

   async selectDelimiter(): Promise<void> {
      if (this.pickingDelimiter || this.editing || this.disposed) {
         return;
      }
      this.pickingDelimiter = true;
      try {
         const choices = [
            { label: "Auto detect", value: "auto" },
            ...delimiters,
            { label: "Custom…", value: "custom" },
         ];
         const choice = await vscode.window.showQuickPick(choices, {
            title: "CSV Table Editor: Select Delimiter",
            placeHolder: this.manualDelimiter ? "Choose a delimiter for this file" : "Auto detect is active",
         });
         if (!choice || this.disposed) {
            return;
         }
         const value =
            choice.value === "custom"
               ? await vscode.window.showInputBox({
                    title: "Custom delimiter",
                    value: this.manualDelimiter,
                    validateInput: delimiterError,
                 })
               : choice.value;
         if (value === undefined || this.disposed || this.editing) {
            return;
         }
         this.manualDelimiter = value === "auto" ? undefined : value;
         this.autoDelimiter = undefined;
         this.sync(true);
         await this.context.workspaceState.update(this.delimiterKey, this.manualDelimiter);
      } catch (error) {
         void vscode.window.showWarningMessage(error instanceof Error ? error.message : "Could not remember the delimiter.");
      } finally {
         this.pickingDelimiter = false;
      }
   }

   private updateSnapshot(): void {
      const text = this.document.getText();
      const delimiter = this.manualDelimiter ?? (this.autoDelimiter ??= detectDelimiter(text, this.fallback));
      let error: string | undefined;
      this.parsed = undefined;
      try {
         this.parsed = parseDocument(text, delimiter, this.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
      } catch (failure) {
         error = failure instanceof Error ? failure.message : "Could not parse the document.";
      }
      const records = this.parsed?.rows.map((row, id) => ({ id, line: row.startLine, values: row.values })) ?? [];
      const config = vscode.workspace.getConfiguration("csv-table-editor", this.document.uri);
      const tableHeader = config.get<boolean>("tableHeader", true) !== false;
      this.snapshot = {
         revision: (this.snapshot?.revision ?? 0) + 1,
         version: this.document.version,
         resource: this.document.uri.toString(),
         delimiter,
         autoDelimiter: this.manualDelimiter === undefined,
         cellMaxWidth: this.cellMaxWidth,
         tableHeader,
         showRowNumbers: config.get<boolean>("showRowNumbers", true) !== false,
         columnCount: this.parsed?.columnCount ?? 0,
         header: tableHeader ? records[0] : undefined,
         records: tableHeader ? records.slice(1) : records,
         error,
      };
   }

   private sync(force = false): void {
      if (force || this.document.version !== this.snapshot.version) {
         this.updateSnapshot();
         this.post({ type: "snapshot", snapshot: this.snapshot });
         this.git.schedule();
      }
   }

   private post(message: HostMessage): void {
      if (this.ready && !this.disposed) {
         void this.panel.webview.postMessage(message);
      }
   }

   private async receive(message: WebviewMessage): Promise<void> {
      if (message.type === "ready") {
         if (this.document.version !== this.snapshot.version) {
            this.updateSnapshot();
         }
         this.ready = true;
         this.keyboardMode = "inactive";
         this.hasSelectedCell = false;
         this.onKeyboardModeChange();
         this.post({ type: "textWrapping", enabled: this.textWrapping });
         this.post({
            type: "snapshot",
            snapshot: this.snapshot,
            savedColumnWidths: this.context.workspaceState.get<Record<string, number>>(this.columnWidthsKey, {}),
         });
         this.git.schedule();
      } else if (message.type === "delimiter") {
         await this.selectDelimiter();
      } else if (message.type === "clearAndReload") {
         await this.clearAndReload();
      } else if (message.type === "keyboardMode") {
         this.keyboardMode = message.mode;
         this.hasSelectedCell = message.hasSelectedCell;
         this.onKeyboardModeChange();
      } else if (message.type === "columnResized") {
         await this.saveColumnWidth(message.column, message.width);
      } else {
         let error: string | undefined;
         if (this.editing) {
            error = "Another edit is still being applied.";
         } else {
            this.editing = true;
            try {
               if (message.type === "edit") {
                  await this.apply(message);
               } else {
                  this.checkDocumentVersion(message.revision, message.version);
               }
               if ((message.type === "save" || message.save) && !(await this.document.save()) && this.document.isDirty) {
                  throw new Error("VS Code could not save this file.");
               }
            } catch (failure) {
               error = failure instanceof Error ? failure.message : "The edit could not be applied.";
            } finally {
               this.editing = false;
            }
         }
         this.sync();
         if (error) {
            this.post({ type: "snapshot", snapshot: this.snapshot });
         }
         this.post({ type: "editResult", revision: message.revision, error });
      }
   }

   private async saveColumnWidth(column: number, width: number): Promise<void> {
      if (this.disposed || column >= this.snapshot.columnCount) {
         return;
      }
      const state = this.context.workspaceState;
      const widths = state.get<Record<string, number>>(this.columnWidthsKey, {});
      const field = `c${column}`;
      try {
         await state.update(this.columnWidthsKey, { ...widths, [field]: width });
      } catch {
         void vscode.window.showWarningMessage("Could not save the column width for this file.");
      }
   }

   private async apply({ revision, version, operation }: Extract<WebviewMessage, { type: "edit" }>): Promise<void> {
      this.checkDocumentVersion(revision, version);
      const parsed = this.parsed;
      if (!parsed) {
         throw new Error("The document could not be parsed.");
      }
      let editOperation: Exclude<Operation, { kind: "rename" }>;
      if (operation.kind === "rename") {
         if (!this.snapshot.header) {
            throw new Error("Enable the first record as a header to rename a column.");
         }
         if (operation.column < 0 || operation.column >= parsed.columnCount) {
            throw new Error("Select a column first.");
         }
         const name = await vscode.window.showInputBox({
            title: "Rename column",
            value: parsed.rows[0].values[operation.column] ?? "",
         });
         if (name === undefined) {
            return;
         }
         editOperation = { kind: "cell", row: 0, column: operation.column, value: name };
      } else {
         editOperation = operation;
      }
      this.checkDocumentVersion(revision, version);
      if (editOperation.kind === "cell") {
         editOperation = { ...editOperation, value: editOperation.value.replace(/\r\n|\r|\n/g, parsed.newline) };
      }
      const replacements = documentEdits(parsed, editOperation, this.snapshot.tableHeader);
      if (!replacements.length) {
         return;
      }
      const edit = new vscode.WorkspaceEdit();
      for (const replacement of replacements) {
         edit.replace(
            this.document.uri,
            new vscode.Range(this.document.positionAt(replacement.start), this.document.positionAt(replacement.end)),
            replacement.text,
         );
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
         throw new Error("VS Code rejected the edit. The table has been refreshed.");
      }
   }

   private checkDocumentVersion(revision: number, version: number): void {
      if (this.disposed || revision !== this.snapshot.revision || version !== this.document.version) {
         throw new Error("The document changed. Try the edit again on the current table.");
      }
   }
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null;
}

function isWebviewMessage(value: unknown): value is WebviewMessage {
   if (!isRecord(value)) {
      return false;
   }
   if (value.type === "ready" || value.type === "delimiter" || value.type === "clearAndReload") {
      return true;
   }
   if (value.type === "keyboardMode") {
      return (
         typeof value.hasSelectedCell === "boolean" && (value.mode === "inactive" || value.mode === "grid" || value.mode === "editing")
      );
   }
   if (value.type === "columnResized") {
      return (
         typeof value.column === "number" &&
         Number.isSafeInteger(value.column) &&
         value.column >= 0 &&
         typeof value.width === "number" &&
         Number.isSafeInteger(value.width) &&
         value.width > 0
      );
   }
   return (
      Number.isSafeInteger(value.revision) &&
      Number.isSafeInteger(value.version) &&
      (value.type === "save" ||
         (value.type === "edit" && (value.save === undefined || typeof value.save === "boolean") && isOperation(value.operation)))
   );
}

function isOperation(value: unknown): value is Operation {
   if (!isRecord(value)) {
      return false;
   }
   const hasRow = Number.isSafeInteger(value.row);
   const hasColumn = Number.isSafeInteger(value.column);
   const hasDirection = value.direction === 1 || value.direction === -1;
   switch (value.kind) {
      case "cell":
         return hasRow && hasColumn && typeof value.value === "string";
      case "rename":
      case "deleteColumn":
         return hasColumn;
      case "deleteRow":
         return hasRow;
      case "moveRow":
         return hasRow && hasDirection;
      case "moveColumn":
         return hasColumn && hasDirection;
      case "addRow":
      case "addColumn":
         return (
            value.before === undefined ||
            (typeof value.before === "number" && Number.isSafeInteger(value.before) && value.before >= 0)
         );
      default:
         return false;
   }
}

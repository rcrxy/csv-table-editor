import * as vscode from "vscode";
import { delimiters, delimiterError, detectDelimiter, parseDocument, type ParsedDocument } from "../core/CsvParser";
import { documentEdits } from "../core/DocumentEdits";
import { GitGutter } from "../git/GitGutter";
import type { HostMessage, Operation, Snapshot, WebviewMessage } from "../shared/messages";
import { configureWebview } from "./webview";

export const viewType = "csv-table-editor.table";

export class CsvTableEditorProvider implements vscode.CustomTextEditorProvider {
   private readonly sessions = new Set<DocumentController>();

   constructor(private readonly context: vscode.ExtensionContext) {}

   resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
      const session = new DocumentController(this.context, document, panel);
      this.sessions.add(session);
      panel.onDidDispose(() => this.sessions.delete(session));
   }

   async selectDelimiter(): Promise<void> {
      const session = [...this.sessions].find(({ panel }) => panel.active);
      if (session) {
         await session.selectDelimiter();
      } else {
         void vscode.window.showInformationMessage("Open a CSV or TSV file in CSV Table Editor first.");
      }
   }
}

class DocumentController {
   private readonly delimiterKey: string;
   private readonly fallback: string;
   private readonly cellMaxWidth: number;
   private manualDelimiter: string | undefined;
   private autoDelimiter: string | undefined;
   private parsed: ParsedDocument | undefined;
   private snapshot!: Snapshot;
   private ready = false;
   private disposed = false;
   private editing = false;
   private pickingDelimiter = false;
   private readonly git: GitGutter;

   constructor(
      private readonly context: vscode.ExtensionContext,
      private readonly document: vscode.TextDocument,
      readonly panel: vscode.WebviewPanel,
   ) {
      this.delimiterKey = `delimiter:${document.uri.toString()}`;
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
            if (event.affectsConfiguration("csv-table-editor.tableHeader", document.uri)) {
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
         delimiter,
         autoDelimiter: this.manualDelimiter === undefined,
         cellMaxWidth: this.cellMaxWidth,
         tableHeader,
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
         this.sync();
         this.ready = true;
         this.post({ type: "snapshot", snapshot: this.snapshot });
         this.git.schedule();
      } else if (message.type === "delimiter") {
         await this.selectDelimiter();
      } else {
         let error: string | undefined;
         if (this.editing) {
            error = "Another edit is still being applied.";
         } else {
            this.editing = true;
            try {
               await this.apply(message);
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

   private async apply({ revision, version, operation }: Extract<WebviewMessage, { type: "edit" }>): Promise<void> {
      const parsed = this.parsed;
      if (!parsed || revision !== this.snapshot.revision || version !== this.document.version) {
         throw new Error("The document changed. Try the edit again on the current table.");
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
      if (this.disposed || revision !== this.snapshot.revision || version !== this.document.version) {
         throw new Error("The document changed. Try the edit again on the current table.");
      }
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null;
}

function isWebviewMessage(value: unknown): value is WebviewMessage {
   if (!isRecord(value)) {
      return false;
   }
   if (value.type === "ready" || value.type === "delimiter") {
      return true;
   }
   return (
      value.type === "edit" &&
      Number.isSafeInteger(value.revision) &&
      Number.isSafeInteger(value.version) &&
      isOperation(value.operation)
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
         return true;
      default:
         return false;
   }
}

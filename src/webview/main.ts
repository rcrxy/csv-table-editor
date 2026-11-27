import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition, type RowComponent } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";
import "./styles.css";
import markup from "./body.html";
import { formatClipboardColumn } from "../core/ColumnClipboard";
import type {
   Direction,
   HostMessage,
   KeyboardMode,
   Operation,
   Snapshot,
   StructureMenuCommand,
   TableAction,
   WebviewMessage,
} from "../shared/messages";
import { measureInitialWidths } from "./columnWidths";
import { GutterView } from "./GutterView";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
// esbuild 将 body.html 打进 Webview 脚本，重载 Webview 时会重新挂载这份模板。
document.body.insertAdjacentHTML("afterbegin", markup);
const tableElement = document.getElementById("table")!;
const statusElement = document.getElementById("status")!;
const widths = new Map<string, number>();

// 文档快照来自扩展宿主，行列选择、列宽和冻结范围属于当前视图。
let snapshot: Snapshot | undefined;
let pending: number | undefined;
let reloadAfterEdit = false;
let selectionAfterEdit: { row: number; column: number } | undefined;
let selectedRow: number | undefined;
let selectedColumn: number | undefined;
let selectedCell: { row: number; column: number } | undefined;
let frozenRowCount = 0;
let frozenColumnCount = 0;
let renderedColumns = "";
let textWrapping = false;
let editingCell: CellComponent | undefined;
let editingHeader:
   | { row: number; column: number; input: HTMLTextAreaElement; label: HTMLElement; value: string }
   | undefined;
let editorBlurring = false;
let keyboardMode: KeyboardMode = "inactive";
let hasSelectedCell = false;
let composing = false;
let notice = "";
let queuedSnapshots = 0;
let updates = Promise.resolve();

const table = new Tabulator(tableElement, {
   index: "id",
   height: "100%",
   layout: "fitDataFill",
   columnDefaults: { headerSort: false },
   editTriggerEvent: "dblclick",
   keybindings: { navUp: false, navDown: false, navLeft: false, navRight: false },
   placeholder: "No data records",
   rowFormatter: (row) => {
      const element = row.getElement();
      const id = Number(row.getIndex());
      element.dataset.recordId = String(id);
      element.classList.toggle("selected-record", id === selectedRow);
   },
});
// 从滚动条上的 Git 标记定位到记录。表头和文件末尾没有对应的数据行。
const gutter = new GutterView(
   table,
   tableElement,
   document.getElementById("overview")!,
   document.getElementById("end-markers")!,
   (row, line) => {
      if (row === snapshot?.header?.id) {
         tableElement.focus();
      } else if (row === null) {
         document.getElementById("end-markers")!.scrollIntoView({ block: "nearest" });
      } else {
         const target = table.getRow(row);
         if (target && target.isFrozen()) {
            selectRow(row);
            return;
         }
         void table.scrollToRow(row, "center").then(
            () => selectRow(row),
            () => {
               notice = `Source line ${line} is hidden by the current filter.`;
               refreshControls();
            },
         );
      }
   },
);

// 首次打开或重载后，等表格就绪再向宿主请求文档快照。
table.on("tableBuilt", () => {
   gutter.attachScrollTrack();
   vscode.postMessage({ type: "ready" });
   updateKeyboardMode(true);
});
table.on("cellClick", (event, cell) => {
   const index = columnIndex(cell.getField());
   const row = Number(cell.getRow().getIndex());
   if (index !== undefined) {
      selectCell(row, index);
   } else {
      clearCellSelection();
      selectRow(row);
   }
   if (!(event.target instanceof HTMLTextAreaElement)) {
      tableElement.focus({ preventScroll: true });
   }
});
table.on("headerClick", (event, column) => {
   if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
      const index = columnIndex(column.getField());
      clearCellSelection();
      if (index !== undefined) {
         selectRow(undefined);
      }
      selectColumn(index);
      tableElement.focus({ preventScroll: true });
   }
});
table.on("headerDblClick", (event, column) => {
   const target = event.target;
   const index = columnIndex(column.getField());
   if (index !== undefined && target instanceof Element && target.closest(".tabulator-col-title")) {
      startHeaderEdit(index);
   }
});
table.on("columnResized", (column) => {
   const field = column.getField();
   const index = columnIndex(field);
   const width = Math.round(column.getWidth());
   if (index === undefined || !Number.isSafeInteger(width) || width <= 0) {
      return;
   }
   widths.set(field, width);
   // Tabulator 重绘时会从列定义读取宽度，沿用用户刚调整的值。
   column.getDefinition().width = width;
   vscode.postMessage({ type: "columnResized", column: index, width });
});
table.on("dataFiltered", (_filters, rows) => {
   if (selectedRow !== undefined && !rows.some((row) => Number(row.getIndex()) === selectedRow)) {
      selectRow(undefined);
   } else {
      refreshControls();
   }
});
table.on("cellEditing", (cell) => {
   editingCell = cell;
   editorBlurring = false;
   const column = columnIndex(cell.getField());
   if (column !== undefined) {
      selectCell(Number(cell.getRow().getIndex()), column);
   }
   refreshControls();
});
table.on("cellEditCancelled", (cell) => {
   const restoreFocus = keyboardMode === "editing" && !editorBlurring;
   editingCell = undefined;
   composing = false;
   updateTextWrapping();
   if (cell.getRow().isFrozen()) {
      table.redraw();
   }
   // Tabulator 会移除输入框。等浏览器处理完焦点切换，再决定是否接回焦点。
   queueMicrotask(() => {
      if (editingCell || editingHeader) {
         return;
      }
      if (restoreFocus && document.hasFocus() && document.activeElement === document.body) {
         tableElement.focus({ preventScroll: true });
      }
      updateKeyboardMode();
      if (keyboardMode === "inactive") {
         clearCellSelection();
      }
      refreshControls();
   });
});
table.on("cellEdited", (cell) => {
   editingCell = undefined;
   composing = false;
   const column = columnIndex(cell.getField());
   const row = Number(cell.getRow().getIndex());
   if (column !== undefined && !send({ kind: "cell", row, column, value: String(cell.getValue()) })) {
      cell.restoreOldValue();
   }
   updateTextWrapping();
   refreshControls();
});

tableElement.addEventListener("focusin", () => {
   editorBlurring = false;
   updateKeyboardMode();
});
tableElement.addEventListener("focusout", () => queueMicrotask(updateKeyboardMode));
tableElement.addEventListener(
   "blur",
   ({ target }) => {
      // 输入框仍在编辑单元格内时收到 blur，表示焦点原本就在离开输入框。
      if (target instanceof HTMLTextAreaElement && target.closest(".tabulator-cell.tabulator-editing")) {
         editorBlurring = true;
      }
   },
   true,
);
window.addEventListener("focus", () => updateKeyboardMode());
window.addEventListener("blur", () => updateKeyboardMode());
tableElement.addEventListener("compositionstart", () => {
   composing = true;
   updateKeyboardMode();
});
tableElement.addEventListener("compositionend", () => {
   composing = false;
   updateKeyboardMode();
});

// 快捷键和右键菜单沿用 VS Code 的原生剪贴板命令。
window.addEventListener("copy", (event) => {
   const clipboard = event.clipboardData;
   if (!clipboard || !snapshot || !canUseGridClipboard(event)) {
      return;
   }
   const column = selectedHeaderColumn();
   const cell = selectedCell && cellAt(selectedCell.row, selectedCell.column);
   const text = column === undefined ? cell && String(cell.getValue() ?? "") : formatClipboardColumn(snapshot, column);
   if (text !== undefined) {
      clipboard.setData("text/plain", text);
      event.preventDefault();
   }
});

window.addEventListener("paste", (event) => {
   const clipboard = event.clipboardData;
   if (!clipboard?.types.includes("text/plain") || !canUseGridClipboard(event)) {
      return;
   }
   const text = clipboard.getData("text/plain");
   const headerColumn = selectedHeaderColumn();
   if (headerColumn !== undefined) {
      event.preventDefault();
      if (text) {
         send({ kind: "pasteTableColumn", column: headerColumn, text });
      }
      return;
   }
   const cell = selectedCell && cellAt(selectedCell.row, selectedCell.column);
   const column = cell && columnIndex(cell.getField());
   if (!cell || column === undefined) {
      return;
   }
   event.preventDefault();
   const lines = text.replace(/(?:\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/);
   const row = Number(cell.getRow().getIndex());
   if (lines.length > 1) {
      send({ kind: "pasteColumn", row, column, values: lines });
      return;
   }
   const [value] = lines;
   if (value !== String(cell.getValue() ?? "")) {
      send({ kind: "cell", row, column, value });
   }
});

function selectedHeaderColumn(): number | undefined {
   return selectedRow === undefined && !selectedCell ? selectedColumn : undefined;
}

function canUseGridClipboard(event: ClipboardEvent): boolean {
   const target = event.target;
   if (
      !event.isTrusted ||
      event.defaultPrevented ||
      editingCell ||
      editingHeader ||
      !snapshot ||
      snapshot.error ||
      pending !== undefined ||
      queuedSnapshots ||
      (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea")))
   ) {
      return false;
   }
   updateKeyboardMode();
   return keyboardMode === "grid";
}

// Enter 和 Ctrl+Enter 由 VS Code 命令处理，挡住浏览器可能先插入的换行。
tableElement.addEventListener("beforeinput", (event) => {
   if (
      event.target === activeEditorInput() &&
      !composing &&
      !event.isComposing &&
      (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph")
   ) {
      event.preventDefault();
   }
});

// input 同时覆盖键盘输入、粘贴、剪切和输入法更新。
tableElement.addEventListener("input", ({ target }) => {
   const input = activeEditorInput();
   if (input && target === input) {
      resizeEditor(input, editingCell);
   }
});

function activeEditorInput(): HTMLTextAreaElement | undefined {
   return editingHeader?.input ?? editingCell?.getElement().querySelector("textarea") ?? undefined;
}

function resizeEditor(input: HTMLTextAreaElement, cell?: CellComponent): void {
   const previousHeight = input.style.height;
   input.style.height = "auto";
   input.style.height = `${input.scrollHeight}px`;
   if (input.style.height !== previousHeight) {
      const row = cell?.getRow();
      row?.normalizeHeight();
      if (!row || row.isFrozen()) {
         table.redraw();
      }
   }
}

type MenuTarget =
   | { webviewSection: "row"; rowId: number; field?: string }
   | { webviewSection: "cell"; rowId: number; field: string }
   | { webviewSection: "header"; field: string };

// 菜单定位使用源记录 ID。无表头时，删除列的入口取当前视图的第一行。
function menuStructureOperation(
   command: Exclude<StructureMenuCommand, "freezeCell" | "unfreezeCell">,
   field: string | undefined,
   rowId: number | undefined,
): Operation | undefined {
   if (!snapshot || snapshot.error) {
      return;
   }
   if (command === "insertRowAbove" || command === "insertRowBelow") {
      if (rowId !== undefined && dataRecord(snapshot, rowId)) {
         return { kind: "addRow", before: command === "insertRowAbove" ? rowId : rowId + 1 };
      }
      return;
   }
   if (field === undefined) {
      return;
   }
   const column = columnIndex(field);
   if (command === "deleteRow") {
      const rowControls = snapshot.showRowNumbers ? field === "_line" : column === 0;
      if (rowControls && rowId !== undefined && dataRecord(snapshot, rowId)) {
         return { kind: "deleteRow", row: rowId };
      }
      return;
   }
   if (column === undefined || column >= snapshot.columnCount) {
      return;
   }
   if (command === "insertColumnLeft" || command === "insertColumnRight") {
      return { kind: "addColumn", before: command === "insertColumnLeft" ? column : column + 1 };
   }
   if (snapshot.columnCount < 2) {
      return;
   }
   const firstDataRow = !snapshot.tableHeader && rowId !== undefined && table.getRows("active")[0]?.getIndex() === rowId;
   if ((rowId === undefined && snapshot.header) || firstDataRow) {
      return { kind: "deleteColumn", column };
   }
}

function freezePaneTarget(field: string | undefined, rowId: number | undefined): { rows: number; columns: number } | undefined {
   const column = field === undefined ? undefined : columnIndex(field);
   if (
      !snapshot ||
      snapshot.error ||
      rowId === undefined ||
      !dataRecord(snapshot, rowId) ||
      column === undefined ||
      !Number.isInteger(column) ||
      column < 0 ||
      column >= snapshot.columnCount
   ) {
      return;
   }
   const rows = rowId - (snapshot.tableHeader ? 1 : 0);
   return rows || column ? { rows, columns: column } : undefined;
}

function setMenuTarget(element: HTMLElement, target: MenuTarget): void {
   const field = target.field;
   const rowId = "rowId" in target ? target.rowId : undefined;
   const canCopyTableRange = !!snapshot && !snapshot.error && (target.webviewSection === "header" || field === "_line");
   element.dataset.vscodeContext = JSON.stringify({
      ...target,
      revision: snapshot?.revision,
      version: snapshot?.version,
      tableResource: snapshot?.resource,
      canCopyTableRange,
      canPasteTableColumn: canCopyTableRange && target.webviewSection === "header",
      preventDefaultContextMenuItems: canCopyTableRange,
      canFreezePanes: target.webviewSection === "cell" && !!freezePaneTarget(field, rowId),
      hasFrozenPanes: frozenRowCount > 0 || frozenColumnCount > 0,
      canDeleteTableRow: !!menuStructureOperation("deleteRow", field, rowId),
      canDeleteTableColumn: !!menuStructureOperation("deleteColumn", field, rowId),
   });
}

table.on("rowContext", (_event, row) => {
   setMenuTarget(row.getElement(), {
      webviewSection: "row",
      rowId: Number(row.getIndex()),
   });
});

table.on("cellContext", (_event, cell) => {
   const field = cell.getField();
   setMenuTarget(cell.getElement(), {
      webviewSection: field === "_line" ? "row" : "cell",
      rowId: Number(cell.getRow().getIndex()),
      field,
   });
});

table.on("headerContext", (_event, column) => {
   const field = column.getField();
   if (columnIndex(field) !== undefined) {
      setMenuTarget(column.getElement(), { webviewSection: "header", field });
   }
});

// 快照渲染可能异步完成，按消息顺序处理，并丢弃不属于当前快照的 Git 标记。
window.addEventListener("message", ({ data }: MessageEvent<HostMessage>) => {
   if (!data || typeof data !== "object") {
      return;
   }
   if (data.type === "snapshot") {
      queuedSnapshots++;
      editingCell?.cancelEdit();
      closeHeaderEditor(editingHeader?.input === document.activeElement);
      refreshControls();
   }
   updates = updates.then(async () => {
      if (data.type === "snapshot") {
         try {
            if (data.savedColumnWidths) {
               for (const [field, width] of Object.entries(data.savedColumnWidths)) {
                  if (/^c\d+$/.test(field) && Number.isSafeInteger(width) && width > 0) {
                     widths.set(field, width);
                  }
               }
               renderedColumns = "";
            }
            await render(data.snapshot);
         } finally {
            queuedSnapshots--;
         }
      } else if (data.type === "textWrapping") {
         textWrapping = data.enabled;
         updateTextWrapping();
      } else if (data.type === "tableAction") {
         runTableAction(data.action);
      } else if (data.type === "editResult" && data.revision === pending) {
         pending = undefined;
         notice = data.error ?? "";
         const shouldReload = reloadAfterEdit;
         const nextSelection = selectionAfterEdit;
         reloadAfterEdit = false;
         selectionAfterEdit = undefined;
         if (data.error) {
            selectRow(undefined);
            selectColumn(undefined);
         } else if (shouldReload) {
            vscode.postMessage({ type: "clearAndReload" });
         } else if (nextSelection) {
            selectAndRevealCell(nextSelection.row, nextSelection.column);
         }
      } else if (data.type === "gutter" && data.revision === snapshot?.revision) {
         gutter.update(data.gutter, snapshot?.header?.id);
      }
      refreshControls();
   }).catch(() => {
      pending = undefined;
      reloadAfterEdit = false;
      selectionAfterEdit = undefined;
      notice = "Unable to update the table. Reopen this editor to reload the document.";
      refreshControls();
   });
});

// 原工具栏事件绑定，改版时可将这组操作接到新控件。
// delimiterButton.onclick = () => vscode.postMessage({ type: "delimiter" });
// addRow.onclick = () => send({ kind: "addRow" });
// deleteRow.onclick = () => selectedRow !== undefined && send({ kind: "deleteRow", row: selectedRow });
// addColumn.onclick = () => send({ kind: "addColumn" });
// deleteColumn.onclick = () => selectedColumn !== undefined && send({ kind: "deleteColumn", column: selectedColumn });
// reset.onclick = () => {
//    table.clearFilter(true);
//    refreshControls();
// };

function button(id: string): HTMLButtonElement {
   return document.getElementById(id) as HTMLButtonElement;
}

function columnIndex(field: string): number | undefined {
   return field.startsWith("c") ? Number(field.slice(1)) : undefined;
}

// 表头和单元格可包含任意文件内容，统一按纯文本渲染。
function asText(value: string): HTMLElement {
   const span = document.createElement("span");
   span.textContent = value;
   return span;
}

function updateKeyboardMode(force = false): void {
   const focused = document.activeElement;
   let mode: KeyboardMode = "inactive";
   if (document.hasFocus() && focused && tableElement.contains(focused)) {
      if (focused === activeEditorInput()) {
         mode = composing ? "composing" : "editing";
      } else if (
         !composing &&
         !(focused instanceof HTMLInputElement) &&
         !(focused instanceof HTMLTextAreaElement) &&
         !(focused instanceof HTMLElement && focused.isContentEditable)
      ) {
         mode = "grid";
      }
   }
   const hasCell = selectedCell !== undefined && !snapshot?.error;
   if (force || mode !== keyboardMode || hasCell !== hasSelectedCell) {
      keyboardMode = mode;
      hasSelectedCell = hasCell;
      vscode.postMessage({ type: "keyboardMode", mode, hasSelectedCell });
   }
}

function runTableAction(action: TableAction): void {
   if (composing) {
      return;
   }
   if (action.kind === "prepareCacheReload") {
      // 先提交单元格草稿，等宿主更新文档后再判断是否有未保存内容。
      submitCellEdit(false);
      if (pending === undefined) {
         vscode.postMessage({ type: "clearAndReload" });
      } else {
         reloadAfterEdit = true;
      }
      return;
   }
   if (action.kind === "pasteTableColumn") {
      if (snapshot?.revision === action.revision && snapshot.version === action.version) {
         send({ kind: "pasteTableColumn", column: action.column, text: action.text });
      }
      return;
   }
   if (action.kind === "editStructureFromMenu") {
      const { field, rowId, revision, version } = action.target;
      if (snapshot?.revision === revision && snapshot.version === version) {
         if (action.command === "freezeCell") {
            const target = freezePaneTarget(field, rowId);
            if (target) {
               setFrozenPanes(target.rows, target.columns);
            }
         } else if (action.command === "unfreezeCell") {
            setFrozenPanes(0, 0);
         } else {
            send(menuStructureOperation(action.command, field, rowId));
         }
      }
      return;
   }
   if (action.kind === "submitCellEdit") {
      if (keyboardMode === "editing") {
         submitCellEdit(action.save, true);
      }
      return;
   }
   if (action.kind === "cancelCellEdit") {
      if (keyboardMode === "editing") {
         if (editingHeader) {
            closeHeaderEditor(true);
         } else {
            editingCell?.cancelEdit();
         }
      }
      return;
   }
   if (action.kind === "insertCellLineBreak" || action.kind === "editCellHistory") {
      const input = activeEditorInput();
      if (keyboardMode === "editing" && input && document.activeElement === input) {
         // 让换行与键入、删除和粘贴共用输入框的浏览器撤销历史。
         if (action.kind === "insertCellLineBreak") {
            document.execCommand("insertText", false, "\n");
         } else {
            document.execCommand(action.command);
         }
      }
      return;
   }
   if (action.kind === "editCell" || action.kind === "clearCell") {
      if (editingCell || editingHeader) {
         return;
      }
      let cell: CellComponent | undefined;
      if (action.target) {
         const { row, column, revision, version } = action.target;
         if (snapshot?.revision === revision && snapshot.version === version) {
            cell = cellAt(row, column);
         }
      } else if (keyboardMode === "grid") {
         if (selectedCell) {
            cell = cellAt(selectedCell.row, selectedCell.column);
         } else if (action.kind === "editCell") {
            if (snapshot?.header && selectedRow === undefined && selectedColumn !== undefined) {
               startHeaderEdit(selectedColumn);
               return;
            }
            cell = selectedOrFirstCell();
         }
      }
      if (!cell) {
         return;
      }
      if (action.kind === "editCell") {
         cell.edit();
      } else {
         const column = columnIndex(cell.getField());
         if (column !== undefined && (cell.getValue() ?? "") !== "") {
            send({ kind: "cell", row: Number(cell.getRow().getIndex()), column, value: "" });
         }
      }
      return;
   }
   if (keyboardMode === "grid") {
      const vertical = action.direction === "up" || action.direction === "down";
      const direction = action.direction === "up" || action.direction === "left" ? -1 : 1;
      if (action.kind === "moveCellSelection") {
         moveCellSelection(vertical, direction);
      } else {
         moveSelection(vertical, direction);
      }
   }
}

function startHeaderEdit(column: number): void {
   if (!snapshot?.header || snapshot.error || pending !== undefined || queuedSnapshots || editingCell || editingHeader) {
      return;
   }
   const header = snapshot.header;
   const component = table.getColumn(`c${column}`);
   const label = component ? component.getElement().querySelector<HTMLElement>(".column-header-label") : null;
   if (!label?.isConnected) {
      return;
   }
   selectRow(undefined);
   selectColumn(column);
   const input = document.createElement("textarea");
   input.className = "column-header-editor";
   input.rows = 1;
   input.wrap = "soft";
   input.setAttribute("aria-label", label.textContent ?? "");
   input.dataset.vscodeContext = JSON.stringify({
      webviewSection: "headerEditor",
      canCopyTableRange: false,
      canPasteTableColumn: false,
      canDeleteTableColumn: false,
      preventDefaultContextMenuItems: false,
   });
   const value = (header.values[column] ?? "").replace(/\r\n?/g, "\n");
   input.value = value;
   editingHeader = { row: header.id, column, input, label, value };
   input.addEventListener("blur", () => {
      if (editingHeader?.input === input) {
         submitHeaderEdit(false);
      }
   });
   label.replaceWith(input);
   input.focus({ preventScroll: true });
   resizeEditor(input);
}

function closeHeaderEditor(restoreFocus = false): void {
   if (!editingHeader) {
      return;
   }
   const { input, label } = editingHeader;
   editingHeader = undefined;
   composing = false;
   input.replaceWith(label);
   table.redraw();
   if (restoreFocus) {
      tableElement.focus({ preventScroll: true });
   }
   updateTextWrapping();
   refreshControls();
}

function submitHeaderEdit(save: boolean, moveToNextRow = false, restoreFocus = false): void {
   if (!editingHeader) {
      return;
   }
   const { row, column, input, value: original } = editingHeader;
   const value = input.value;
   const nextRow = moveToNextRow ? table.getRows("active")[0] : undefined;
   closeHeaderEditor(restoreFocus);
   if (send(value === original ? undefined : { kind: "cell", row, column, value }, save)) {
      selectionAfterEdit = nextRow ? { row: Number(nextRow.getIndex()), column } : undefined;
   }
}

function submitCellEdit(save: boolean, moveToNextRow = false): void {
   if (editingHeader) {
      submitHeaderEdit(save, moveToNextRow, true);
      return;
   }
   const cell = editingCell;
   const input = cell?.getElement().querySelector("textarea");
   const column = cell && columnIndex(cell.getField());
   if (!cell || !input || column === undefined) {
      return;
   }
   const currentRow = cell.getRow();
   const row = Number(currentRow.getIndex());
   // 按提交前的表格顺序定位下一行，避免提交后筛选结果变化导致跳行。
   const nextRow = moveToNextRow && adjacentRow(currentRow, 1);
   const nextSelection = nextRow ? { row: Number(nextRow.getIndex()), column } : undefined;
   const value = input.value;
   const original = String(cell.getValue() ?? "").replace(/\r\n?/g, "\n");
   // 退出 Tabulator 的输入框，草稿通过既有的文档编辑流程提交。
   cell.cancelEdit();
   tableElement.focus({ preventScroll: true });
   if (send(value === original ? undefined : { kind: "cell", row, column, value }, save)) {
      selectionAfterEdit = nextSelection;
   } else if (!save && value === original && nextSelection) {
      selectAndRevealCell(nextSelection.row, nextSelection.column);
   }
}

function updateTextWrapping(): void {
   if (editingCell || editingHeader || tableElement.classList.contains("wrap-cell-text") === textWrapping) {
      return;
   }
   tableElement.classList.toggle("wrap-cell-text", textWrapping);
   if (!snapshot) {
      return;
   }

   // 重新计算虚拟列表的行高，恢复切换前的首个可见行和横向滚动量。
   const firstVisibleRow = table.getRows("visible")[0];
   const viewport = tableElement.querySelector<HTMLElement>(".tabulator-tableholder");
   const scrollLeft = viewport?.scrollLeft ?? 0;
   table.redraw(true);
   if (firstVisibleRow) {
      void table.scrollToRow(firstVisibleRow, "top", true).catch(() => {});
   }
   if (viewport) {
      viewport.scrollLeft = scrollLeft;
   }
}

function selectRow(row: number | undefined): void {
   if (selectedCell && selectedCell.row !== row) {
      clearCellSelection();
   }
   if (selectedRow !== undefined) {
      const previous = table.getRow(selectedRow);
      if (previous) {
         previous.getElement().classList.remove("selected-record");
      }
   }
   selectedRow = row;
   if (row !== undefined) {
      const record = table.getRow(row);
      if (record) {
         record.getElement().classList.add("selected-record");
      }
   }
   refreshControls();
}

function selectColumn(column: number | undefined): void {
   if (selectedCell && selectedCell.column !== column) {
      clearCellSelection();
   }
   if (selectedColumn !== undefined) {
      const old = table.getColumn(`c${selectedColumn}`);
      if (old) {
         old.getElement().classList.remove("selected-column");
      }
   }
   selectedColumn = column;
   if (column !== undefined) {
      const selected = table.getColumn(`c${column}`);
      if (selected) {
         selected.getElement().classList.add("selected-column");
      }
   }
   refreshControls();
}

function cellAt(row: number, column: number): CellComponent | undefined {
   if (!snapshot || !dataRecord(snapshot, row) || !Number.isInteger(column) || column < 0 || column >= snapshot.columnCount) {
      return;
   }
   const component = table.getRow(row);
   return component ? component.getCell(`c${column}`) || undefined : undefined;
}

function clearCellSelection(): void {
   if (selectedCell) {
      const cell = cellAt(selectedCell.row, selectedCell.column)?.getElement();
      cell?.classList.remove("selected-cell");
      cell?.removeAttribute("aria-selected");
      selectedCell = undefined;
   }
}

function selectCell(row: number, column: number): void {
   clearCellSelection();
   selectedCell = { row, column };
   selectRow(row);
   selectColumn(column);
   const cell = cellAt(row, column)?.getElement();
   cell?.classList.add("selected-cell");
   cell?.setAttribute("aria-selected", "true");
}

function selectedOrFirstCell(): CellComponent | undefined {
   if (selectedCell) {
      return cellAt(selectedCell.row, selectedCell.column);
   }
   const row =
      selectedRow === undefined ? (table.getRows("visible")[0] ?? table.getRows("active")[0]) : table.getRow(selectedRow);
   return row ? cellAt(Number(row.getIndex()), selectedColumn ?? 0) : undefined;
}

function moveCellSelection(vertical: boolean, direction: Direction): void {
   const current = selectedOrFirstCell();
   const column = current && columnIndex(current.getField());
   if (!current || column === undefined) {
      return;
   }
   const row = current.getRow();
   const nextRow = selectedCell && vertical ? adjacentRow(row, direction) : row;
   const nextColumn = selectedCell && !vertical ? column + direction : column;
   if (!nextRow) {
      return;
   }
   selectAndRevealCell(Number(nextRow.getIndex()), nextColumn);
}

function adjacentRow(row: RowComponent, direction: Direction): RowComponent | false {
   if (!row.isFrozen()) {
      const next = direction < 0 ? row.getPrevRow() : row.getNextRow();
      if (next || direction > 0 || frozenRowCount === 0) {
         return next;
      }
   }
   // Tabulator 将冻结行移出滚动区域的行序列，跨越冻结边界时按活动记录顺序查找。
   const rows = table.getRows("active");
   const index = rows.findIndex((candidate) => candidate.getIndex() === row.getIndex());
   return index < 0 ? false : (rows[index + direction] ?? false);
}

function selectAndRevealCell(row: number, column: number): void {
   const destination = cellAt(row, column);
   const target = destination?.getRow();
   if (destination && target && (target.isFrozen() || target.getPosition() !== false)) {
      selectCell(row, column);
      const selection = selectedCell;
      requestAnimationFrame(() => {
         // 连续按键时，只滚动到当前选中的单元格。
         if (selection && selectedCell === selection) {
            void revealSelectedCell(selection);
         }
      });
   }
}

async function revealSelectedCell(selection: { row: number; column: number }): Promise<void> {
   let cell = cellAt(selection.row, selection.column);
   const viewport = tableElement.querySelector<HTMLElement>(".tabulator-tableholder");
   if (!cell || !viewport?.clientHeight || !viewport.clientWidth) {
      return;
   }
   const initialRow = cell.getRow();
   if (!initialRow.isFrozen() && !viewport.contains(cell.getElement())) {
      // 虚拟列表中尚未挂载的行，先交给 Tabulator 定位并渲染。
      try {
         await table.scrollToRow(initialRow, "nearest", true);
      } catch {
         return;
      }
      // 初次渲染会重建单元格节点。
      cell = cellAt(selection.row, selection.column);
   }
   if (selectedCell !== selection || !cell || !tableElement.contains(cell.getElement())) {
      return;
   }

   const row = cell.getRow();
   const bounds = cell.getElement().getBoundingClientRect();
   const area = viewport.getBoundingClientRect();
   if (!row.isFrozen()) {
      const top = area.top + viewport.clientTop;
      const delta = scrollDelta(bounds.top, bounds.bottom, top, top + viewport.clientHeight);
      if (delta) {
         viewport.scrollTop += delta;
      }
   }
   if (selection.column >= frozenColumnCount) {
      const left = area.left + viewport.clientLeft;
      const right = left + viewport.clientWidth;
      const frozenField = frozenColumnCount ? `c${frozenColumnCount - 1}` : "_line";
      const frozenEdge = row.getCell(frozenField);
      const visibleLeft = frozenEdge ? Math.max(left, frozenEdge.getElement().getBoundingClientRect().right) : left;
      const delta = scrollDelta(bounds.left, bounds.right, visibleLeft, right);
      if (delta) {
         viewport.scrollLeft += delta;
      }
   }
}

function scrollDelta(start: number, end: number, visibleStart: number, visibleEnd: number): number {
   if (visibleStart >= visibleEnd) {
      return 0;
   }
   const startOffset = start - visibleStart;
   const endOffset = end - visibleEnd;
   if (startOffset < 0 && endOffset < 0) {
      return Math.max(startOffset, endOffset);
   }
   if (startOffset > 0 && endOffset > 0) {
      return Math.min(startOffset, endOffset);
   }
   return 0;
}

function hasHeaderFilters(): boolean {
   return table.getHeaderFilters().length > 0;
}

function dataRecord(view: Snapshot, id: number | undefined) {
   return id === undefined ? undefined : view.records[id - (view.tableHeader ? 1 : 0)];
}

// 行移动依赖源文件顺序，筛选生效时暂停行移动。
function moveSelection(vertical: boolean, direction: Direction): void {
   if (!snapshot || !selectedCell) {
      return;
   }
   const { row, column } = selectedCell;
   if (vertical && hasHeaderFilters()) {
      notice = "Clear filters before moving a row.";
      refreshControls();
   } else if (vertical) {
      const next = row + direction;
      if (dataRecord(snapshot, next) && send({ kind: "moveRow", row, direction })) {
         selectCell(next, column);
         const target = table.getRow(next);
         if (target && !target.isFrozen()) {
            void table.scrollToRow(target, "nearest", false).catch(() => {});
         }
      }
   } else {
      const next = column + direction;
      if (next >= 0 && next < snapshot.columnCount && send({ kind: "moveColumn", column, direction })) {
         selectCell(row, next);
         if (next >= frozenColumnCount) {
            void table.scrollToColumn(`c${next}`, "middle", false).catch(() => {});
         }
      }
   }
}

// 数据修改携带当前快照和文档版本，由扩展宿主应用到 TextDocument。
function send(operation: Operation | undefined, save = false): boolean {
   if (
      !snapshot ||
      snapshot.error ||
      pending !== undefined ||
      queuedSnapshots ||
      editingCell ||
      editingHeader ||
      (!operation && !save)
   ) {
      return false;
   }
   const { revision, version } = snapshot;
   pending = revision;
   notice = "";
   vscode.postMessage(operation ? { type: "edit", revision, version, operation, save } : { type: "save", revision, version });
   refreshControls();
   return true;
}

function setFrozenPanes(rows: number, columns: number): void {
   if (!snapshot || snapshot.error || pending !== undefined || queuedSnapshots || editingCell || editingHeader) {
      return;
   }
   const rowsChanged = rows !== frozenRowCount;
   const columnsChanged = columns !== frozenColumnCount;
   frozenRowCount = rows;
   frozenColumnCount = columns;
   if (columnsChanged) {
      applyColumns(snapshot);
   }
   if (rowsChanged) {
      applyFrozenRows();
   }
   refreshControls();
}

function applyFrozenRows(): void {
   const boundary = (snapshot?.tableHeader ? 1 : 0) + frozenRowCount;
   const changes = table.getRows().filter((row) => row.isFrozen() !== (Number(row.getIndex()) < boundary));
   if (!changes.length) {
      return;
   }
   table.blockRedraw();
   try {
      for (const row of changes) {
         if (Number(row.getIndex()) < boundary) {
            row.freeze();
         } else {
            row.unfreeze();
         }
      }
   } finally {
      table.restoreRedraw();
   }
}

// 列结构变化时重建列，沿用列宽与仍存在的列的筛选值。
function applyColumns(next: Snapshot): void {
   const headers = Array.from({ length: next.columnCount }, (_, index) => next.header?.values[index] ?? "");
   const lineDigits = next.showRowNumbers ? Math.max(4, String(next.records.at(-1)?.line ?? 0).length) : undefined;
   const key = JSON.stringify([next.tableHeader, headers, frozenColumnCount, lineDigits]);
   if (key === renderedColumns) {
      return;
   }
   measureInitialWidths(tableElement, next, widths);
   renderedColumns = key;
   const filters = table.getHeaderFilters().filter(({ field }) => (columnIndex(field) ?? Infinity) < headers.length);
   const columns: ColumnDefinition[] = headers.map((name, index) => {
      const field = `c${index}`;
      const width = widths.get(field) ?? Math.min(80, next.cellMaxWidth);
      return {
         title: `Column ${index + 1}`,
         headerHozAlign: "center",
         titleFormatter: () => {
            const label = asText(name || `Column ${index + 1}`);
            label.className = "column-header-label";
            return label;
         },
         field,
         frozen: index < frozenColumnCount,
         width,
         minWidth: Math.min(80, next.cellMaxWidth, width),
         formatter: (cell) => {
            const selected = selectedCell?.row === Number(cell.getRow().getIndex()) && selectedCell?.column === index;
            const element = cell.getElement();
            element.classList.toggle("selected-cell", selected);
            if (selected) {
               element.setAttribute("aria-selected", "true");
            } else {
               element.removeAttribute("aria-selected");
            }
            return asText(String(cell.getValue() ?? ""));
         },
         cssClass: "data-cell",
         variableHeight: true,
         editor: "textarea",
         editorParams: () => ({
            verticalNavigation: "editor",
            elementAttributes: { rows: "1", wrap: "soft" },
         }),
         editable: () => !!snapshot && !snapshot.error && pending === undefined && !queuedSnapshots && !editingHeader,
      };
   });
   // 可选的序列号列显示源文件行号和 Git 标记。数据列的字段名与它的显示状态无关。
   if (lineDigits !== undefined) {
      const lineWidth = gutter.measureWidth(lineDigits);
      columns.unshift({
         title: "#",
         titleFormatter: () => (next.header ? gutter.header() : asText("#")),
         field: "_line",
         frozen: true,
         width: lineWidth,
         minWidth: lineWidth,
         resizable: false,
         hozAlign: "right",
         cssClass: "gutter-cell",
         formatter: (cell) => gutter.record({ id: Number(cell.getRow().getIndex()), line: Number(cell.getValue()) }),
      });
   }
   table.clearHeaderFilter();
   table.setColumns(columns);
   for (const { field, value } of filters) {
      table.setHeaderFilterValue(field, String(value));
   }
   selectColumn(selectedColumn);
}

// 将宿主快照转换为 Tabulator 数据，编辑和定位使用原始记录 ID。
async function render(next: Snapshot): Promise<void> {
   if (snapshot && next.revision < snapshot.revision) {
      return;
   }
   if (next.revision !== snapshot?.revision) {
      const previous = snapshot;
      // 原始行号保持不变时，保留旧标记直到新的 Git 差异返回。
      if (
         !previous ||
         next.error ||
         next.delimiter !== previous.delimiter ||
         next.tableHeader !== previous.tableHeader ||
         next.records.length !== previous.records.length ||
         next.records.some(({ line }, index) => line !== previous.records[index].line)
      ) {
         gutter.update(undefined);
      }
      notice = "";
      if (pending === undefined || next.delimiter !== snapshot?.delimiter) {
         selectRow(undefined);
         selectColumn(undefined);
      }
   }
   snapshot = next;
   if (next.error) {
      await table.replaceData([]);
      return;
   }
   if (selectedRow !== undefined && !dataRecord(next, selectedRow)) {
      selectRow(undefined);
   }
   if (selectedColumn !== undefined && selectedColumn >= next.columnCount) {
      selectColumn(undefined);
   }
   frozenRowCount = Math.min(frozenRowCount, next.records.length);
   frozenColumnCount = next.records.length ? Math.min(frozenColumnCount, next.columnCount) : 0;
   applyColumns(next);
   const data = next.records.map(({ id, line, values }) => {
      const row: Record<string, number | string> = { id, _line: line };
      for (let index = 0; index < next.columnCount; index++) {
         row[`c${index}`] = values[index] ?? "";
      }
      return row;
   });
   const viewport = tableElement.querySelector<HTMLElement>(".tabulator-tableholder");
   const scrollTop = viewport?.scrollTop ?? 0;
   const scrollLeft = viewport?.scrollLeft ?? 0;
   await table.replaceData(data);
   // 替换数据会重建行组件，按冻结边界恢复固定行及原来的滚动位置。
   if (frozenRowCount > 0) {
      applyFrozenRows();
      if (viewport) {
         viewport.scrollTop = scrollTop;
         viewport.scrollLeft = scrollLeft;
      }
   }
}

// 集中更新状态栏，也保留了原工具栏的启用条件供改版时参考。
function refreshControls(): void {
   updateKeyboardMode();
   const busy = pending !== undefined || queuedSnapshots > 0 || editingCell !== undefined || editingHeader !== undefined;
   const editable = !!snapshot && !snapshot.error && !busy;
   // delimiterButton.disabled = !snapshot || busy;
   // addRow.disabled = !editable;
   // deleteRow.disabled = !editable || selectedRow === undefined;
   // addColumn.disabled = !editable;
   // deleteColumn.disabled = !editable || selectedColumn === undefined || (snapshot?.columnCount ?? 0) < 2;
   // reset.disabled = !snapshot || busy || !hasHeaderFilters();
   if (!snapshot) {
      return;
   }
   const delimiter = snapshot.delimiter === "\t" ? "Tab" : snapshot.delimiter === " " ? "Space" : snapshot.delimiter;
   // delimiterButton.textContent = `Delimiter: ${delimiter}${snapshot.autoDelimiter ? " (auto)" : ""}`;
   statusElement.classList.toggle("error", !!snapshot.error);
   const selected = dataRecord(snapshot, selectedRow);
   const summary = [
      `${snapshot.records.length} data rows · ${snapshot.columnCount} columns`,
      selected && `Line ${selected.line}`,
      selectedColumn !== undefined && `Column ${selectedColumn + 1}`,
   ]
      .filter(Boolean)
      .join(" · ");
   statusElement.textContent = snapshot.error ?? (notice || summary);
}

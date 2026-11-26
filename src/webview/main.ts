import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";
import "./styles.css";
import markup from "./body.html";
import type {
   Direction,
   HostMessage,
   KeyboardMode,
   Operation,
   Snapshot,
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
let selectedRow: number | undefined;
let selectedColumn: number | undefined;
let selectedCell: { row: number; column: number } | undefined;
let frozenCount = 0;
let renderedColumns = "";
let textWrapping = false;
let editingCell: CellComponent | undefined;
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
   headerSortClickElement: "icon",
   editTriggerEvent: "dblclick",
   keybindings: { navUp: false, navDown: false, navLeft: false, navRight: false },
   placeholder: "No data records",
   rowFormatter: (row) => row.getElement().classList.toggle("selected-record", Number(row.getIndex()) === selectedRow),
});
// 从概览尺定位到记录。表头和文件末尾没有对应的数据行。
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
   if (!(event.target instanceof HTMLInputElement)) {
      clearCellSelection();
      selectColumn(columnIndex(column.getField()));
      tableElement.focus({ preventScroll: true });
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
table.on("dataSorted", refreshControls);
table.on("cellEditing", (cell) => {
   editingCell = cell;
   const column = columnIndex(cell.getField());
   if (column !== undefined) {
      selectCell(Number(cell.getRow().getIndex()), column);
   }
   refreshControls();
});
table.on("cellEditCancelled", () => {
   editingCell = undefined;
   composing = false;
   updateTextWrapping();
   refreshControls();
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

tableElement.addEventListener("focusin", () => updateKeyboardMode());
tableElement.addEventListener("focusout", () => queueMicrotask(updateKeyboardMode));
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

// VS Code 执行 Enter / Ctrl+Enter 命令。阻止浏览器先往编辑框里插入换行。
// Tabulator 的 Shift+Enter 直接更新编辑文本，仍可插入换行。
tableElement.addEventListener("beforeinput", (event) => {
   if (
      editingCell &&
      event.target instanceof HTMLTextAreaElement &&
      !composing &&
      !event.isComposing &&
      (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph")
   ) {
      event.preventDefault();
   }
});

// Tabulator 会在键盘输入后调整高度。input 也覆盖粘贴、剪切和输入法更新。
tableElement.addEventListener("input", ({ target }) => {
   const cell = editingCell;
   if (!cell || !(target instanceof HTMLTextAreaElement) || !cell.getElement().contains(target)) {
      return;
   }
   const previousHeight = target.style.height;
   target.style.height = "auto";
   target.style.height = `${target.scrollHeight}px`;
   if (target.style.height !== previousHeight) {
      cell.getRow().normalizeHeight();
   }
});

type MenuTarget =
   | { webviewSection: "row"; rowId: number }
   | { webviewSection: "cell"; rowId: number; field: string }
   | { webviewSection: "header"; field: string };

function setMenuTarget(element: HTMLElement, target: MenuTarget): void {
   element.dataset.vscodeContext = JSON.stringify({
      ...target,
      revision: snapshot?.revision,
      version: snapshot?.version,
      hasFrozenColumns: frozenCount > 0,
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
   if (columnIndex(field) === undefined) {
      return; // 左侧行号列沿用行菜单。
   }
   setMenuTarget(cell.getElement(), {
      webviewSection: "cell",
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
         if (data.error) {
            selectRow(undefined);
            selectColumn(undefined);
         }
      } else if (data.type === "gutter" && data.revision === snapshot?.revision) {
         gutter.update(data.gutter);
      }
      refreshControls();
   }).catch(() => {
      pending = undefined;
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
// rename.onclick = () => selectedColumn !== undefined && send({ kind: "rename", column: selectedColumn });
// freeze.onclick = () => {
//    if (snapshot) {
//       const count = selectedColumn === undefined ? 0 : selectedColumn + 1;
//       frozenCount = frozenCount === count ? 0 : count;
//       applyColumns(snapshot);
//       refreshControls();
//    }
// };
// reset.onclick = () => {
//    table.clearFilter(true);
//    table.clearSort();
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
   if (!composing && document.hasFocus() && focused && tableElement.contains(focused)) {
      if (focused instanceof HTMLTextAreaElement && editingCell?.getElement().contains(focused)) {
         mode = "editing";
      } else if (
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
   if (action.kind === "submitCellEdit") {
      if (keyboardMode === "editing") {
         submitCellEdit(action.save);
      }
      return;
   }
   if (action.kind === "editCell") {
      if (editingCell) {
         return;
      }
      if (action.target) {
         const { row, column, revision, version } = action.target;
         if (snapshot?.revision === revision && snapshot.version === version) {
            cellAt(row, column)?.edit();
         }
      } else if (keyboardMode === "grid") {
         selectedOrFirstCell()?.edit();
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

function submitCellEdit(save: boolean): void {
   const cell = editingCell;
   const input = cell?.getElement().querySelector("textarea");
   const column = cell && columnIndex(cell.getField());
   if (!cell || !input || column === undefined) {
      return;
   }
   const row = Number(cell.getRow().getIndex());
   const value = input.value;
   const original = String(cell.getValue() ?? "").replace(/\r\n?/g, "\n");
   // 退出 Tabulator 的输入框，草稿通过既有的文档编辑流程提交。
   cell.cancelEdit();
   tableElement.focus({ preventScroll: true });
   send(value === original ? undefined : { kind: "cell", row, column, value }, save);
}

function updateTextWrapping(): void {
   if (editingCell || tableElement.classList.contains("wrap-cell-text") === textWrapping) {
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
   const nextRow = selectedCell && vertical ? (direction < 0 ? row.getPrevRow() : row.getNextRow()) : row;
   const nextColumn = selectedCell && !vertical ? column + direction : column;
   if (!nextRow) {
      return;
   }
   const id = Number(nextRow.getIndex());
   const destination = cellAt(id, nextColumn);
   if (destination) {
      selectCell(id, nextColumn);
      void table.scrollToRow(nextRow, "nearest", false).catch(() => {});
      void table.scrollToColumn(destination.getField(), "middle", false).catch(() => {});
   }
}

function hasViewOrder(): boolean {
   return table.getSorters().length > 0 || table.getHeaderFilters().length > 0;
}

function dataRecord(view: Snapshot, id: number | undefined) {
   return id === undefined ? undefined : view.records[id - (view.tableHeader ? 1 : 0)];
}

// 行移动依赖源文件顺序，排序或筛选生效时暂停行移动。
function moveSelection(vertical: boolean, direction: Direction): void {
   if (!snapshot || !selectedCell) {
      return;
   }
   const { row, column } = selectedCell;
   if (vertical && hasViewOrder()) {
      notice = "Clear sorting and filters before moving a row.";
      refreshControls();
   } else if (vertical) {
      const next = row + direction;
      if (dataRecord(snapshot, next) && send({ kind: "moveRow", row, direction })) {
         selectCell(next, column);
         void table.scrollToRow(next, "nearest", false).catch(() => {});
      }
   } else {
      const next = column + direction;
      if (next >= 0 && next < snapshot.columnCount && send({ kind: "moveColumn", column, direction })) {
         selectCell(row, next);
         void table.scrollToColumn(`c${next}`, "middle", false).catch(() => {});
      }
   }
}

// 数据修改携带当前快照和文档版本，由扩展宿主应用到 TextDocument。
function send(operation: Operation | undefined, save = false): boolean {
   if (!snapshot || snapshot.error || pending !== undefined || queuedSnapshots || editingCell || (!operation && !save)) {
      return false;
   }
   const { revision, version } = snapshot;
   pending = revision;
   notice = "";
   vscode.postMessage(operation ? { type: "edit", revision, version, operation, save } : { type: "save", revision, version });
   refreshControls();
   return true;
}

// 表头或冻结范围变化时才重建列。重建时沿用列宽，并重新应用仍存在的列的排序和筛选值。
function applyColumns(next: Snapshot): void {
   const headers = Array.from({ length: next.columnCount }, (_, index) => next.header?.values[index] ?? "");
   const lineDigits = Math.max(4, String(next.records.at(-1)?.line ?? 0).length);
   const key = JSON.stringify([next.tableHeader, headers, frozenCount, lineDigits]);
   if (key === renderedColumns) {
      return;
   }
   measureInitialWidths(tableElement, next, widths);
   renderedColumns = key;
   const sorters = table
      .getSorters()
      .filter(({ field }) => (columnIndex(field) ?? Infinity) < headers.length)
      .map(({ field, dir }) => ({ column: field, dir }));
   const filters = table.getHeaderFilters().filter(({ field }) => (columnIndex(field) ?? Infinity) < headers.length);
   // 最左侧冻结列显示源文件行号和 Git 标记，业务列使用 c0、c1 等内部字段名。
   const lineWidth = gutter.measureWidth(lineDigits);
   const stub: ColumnDefinition = {
      title: "#",
      titleFormatter: () => (next.header ? gutter.header() : asText("#")),
      field: "_line",
      frozen: true,
      width: lineWidth,
      minWidth: lineWidth,
      headerSort: false,
      resizable: false,
      hozAlign: "right",
      cssClass: "gutter-cell",
      formatter: (cell) => gutter.record({ id: Number(cell.getRow().getIndex()), line: Number(cell.getValue()) }),
   };
   const columns: ColumnDefinition[] = headers.map((name, index) => {
      const field = `c${index}`;
      const width = widths.get(field) ?? Math.min(80, next.cellMaxWidth);
      return {
         title: `Column ${index + 1}`,
         titleFormatter: () => asText(name || `Column ${index + 1}`),
         field,
         sorter: "string",
         headerSortTristate: true,
         frozen: index < frozenCount,
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
            shiftEnterNewLine: true,
            verticalNavigation: "editor",
            elementAttributes: { rows: "1", wrap: "soft" },
         }),
         editable: () => !!snapshot && !snapshot.error && pending === undefined && !queuedSnapshots,
      };
   });
   table.clearSort();
   table.clearHeaderFilter();
   table.setColumns([stub, ...columns]);
   if (sorters.length) {
      table.setSort(sorters);
   }
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
      gutter.update(undefined);
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
   frozenCount = Math.min(frozenCount, next.columnCount);
   applyColumns(next);
   const data = next.records.map(({ id, line, values }) => {
      const row: Record<string, number | string> = { id, _line: line };
      for (let index = 0; index < next.columnCount; index++) {
         row[`c${index}`] = values[index] ?? "";
      }
      return row;
   });
   await table.replaceData(data);
}

// 集中更新状态栏，也保留了原工具栏的启用条件供改版时参考。
function refreshControls(): void {
   updateKeyboardMode();
   const busy = pending !== undefined || queuedSnapshots > 0 || editingCell !== undefined;
   const editable = !!snapshot && !snapshot.error && !busy;
   // delimiterButton.disabled = !snapshot || busy;
   // addRow.disabled = !editable;
   // deleteRow.disabled = !editable || selectedRow === undefined;
   // addColumn.disabled = !editable;
   // deleteColumn.disabled = !editable || selectedColumn === undefined || (snapshot?.columnCount ?? 0) < 2;
   // rename.disabled = !editable || selectedColumn === undefined;
   // freeze.disabled = !editable || (selectedColumn === undefined && frozenCount === 0);
   const unfreeze = frozenCount > 0 && (selectedColumn === undefined || frozenCount === selectedColumn + 1);
   // freeze.textContent = unfreeze ? "Unfreeze columns" : "Freeze through column";
   // reset.disabled = !snapshot || busy || !hasViewOrder();
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

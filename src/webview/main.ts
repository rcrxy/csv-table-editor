import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";
import "./styles.css";
import markup from "./body.html";
import type { Direction, HostMessage, Operation, Snapshot, WebviewMessage } from "../shared/messages";
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
let frozenCount = 0;
let renderedColumns = "";
let textWrapping = false;
let editingCell: CellComponent | undefined;
let notice = "";
let queuedSnapshots = 0;
let updates = Promise.resolve();

const table = new Tabulator(tableElement, {
   index: "id",
   height: "100%",
   layout: "fitDataFill",
   headerSortClickElement: "icon",
   editTriggerEvent: "dblclick",
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
table.on("tableBuilt", () => vscode.postMessage({ type: "ready" }));
table.on("cellClick", (event, cell) => {
   const index = columnIndex(cell.getField());
   selectRow(Number(cell.getRow().getIndex()));
   if (index !== undefined) {
      selectColumn(index);
   }
   if (!(event.target instanceof HTMLTextAreaElement)) {
      tableElement.focus({ preventScroll: true });
   }
});
table.on("headerClick", (event, column) => {
   if (!(event.target instanceof HTMLInputElement)) {
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
   refreshControls();
});
table.on("cellEditCancelled", () => {
   editingCell = undefined;
   updateTextWrapping();
   refreshControls();
});
table.on("cellEdited", (cell) => {
   editingCell = undefined;
   const column = columnIndex(cell.getField());
   const row = Number(cell.getRow().getIndex());
   if (column !== undefined && !send({ kind: "cell", row, column, value: String(cell.getValue()) })) {
      cell.restoreOldValue();
   }
   updateTextWrapping();
   refreshControls();
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

// Alt+Shift+方向键移动源文件中的行列，输入框内保留按键原有行为。
tableElement.addEventListener("keydown", (event) => {
   if (
      !event.altKey ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
   ) {
      return;
   }
   const key = event.key;
   if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      moveSelection(key === "ArrowUp" || key === "ArrowDown", key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1);
   }
}, true);

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

function hasViewOrder(): boolean {
   return table.getSorters().length > 0 || table.getHeaderFilters().length > 0;
}

function dataRecord(view: Snapshot, id: number | undefined) {
   return id === undefined ? undefined : view.records[id - (view.tableHeader ? 1 : 0)];
}

// 行移动依赖源文件顺序，排序或筛选生效时暂停行移动。
function moveSelection(vertical: boolean, direction: Direction): void {
   if (!snapshot) {
      return;
   }
   if (vertical && hasViewOrder()) {
      notice = "Clear sorting and filters before moving a row.";
      refreshControls();
   } else if (vertical && selectedRow !== undefined) {
      const next = selectedRow + direction;
      if (dataRecord(snapshot, next) && send({ kind: "moveRow", row: selectedRow, direction })) {
         selectRow(next);
         void table.scrollToRow(next, "nearest", false).catch(() => {});
      }
   } else if (!vertical && selectedColumn !== undefined) {
      const next = selectedColumn + direction;
      if (next >= 0 && next < snapshot.columnCount && send({ kind: "moveColumn", column: selectedColumn, direction })) {
         selectColumn(next);
         void table.scrollToColumn(`c${next}`, "middle", false).catch(() => {});
      }
   }
}

// 数据修改携带当前快照和文档版本，由扩展宿主应用到 TextDocument。
function send(operation: Operation): boolean {
   if (!snapshot || snapshot.error || pending !== undefined || queuedSnapshots || editingCell) {
      return false;
   }
   pending = snapshot.revision;
   notice = "";
   vscode.postMessage({ type: "edit", revision: snapshot.revision, version: snapshot.version, operation });
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
         formatter: (cell) => asText(String(cell.getValue() ?? "")),
         cssClass: "data-cell",
         variableHeight: true,
         editor: "textarea",
         editorParams: () => ({
            enterSubmit: true,
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
      selectedRow = undefined;
   }
   if (selectedColumn !== undefined && selectedColumn >= next.columnCount) {
      selectedColumn = undefined;
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

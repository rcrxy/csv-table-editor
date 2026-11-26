import { TabulatorFull as Tabulator, type CellComponent, type ColumnDefinition } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";
import "./styles.css";
import markup from "./body.html";
import type { Direction, HostMessage, Operation, Snapshot, WebviewMessage } from "../shared/messages";
import { GutterView } from "./GutterView";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
document.body.insertAdjacentHTML("afterbegin", markup);
const tableElement = document.getElementById("table")!;
const statusElement = document.getElementById("status")!;
const widths = new Map<string, number>();

let snapshot: Snapshot | undefined;
let pending: number | undefined;
let selectedRow: number | undefined;
let selectedColumn: number | undefined;
let frozenCount = 0;
let renderedColumns = "";
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
const gutter = new GutterView(
   table,
   tableElement,
   document.getElementById("overview")!,
   document.getElementById("end-markers")!,
   (row, line) => {
      if (row === 0) {
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
table.on("columnResized", (column) => widths.set(column.getField(), column.getWidth()));
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
   refreshControls();
});
table.on("cellEdited", (cell) => {
   editingCell = undefined;
   const column = columnIndex(cell.getField());
   const row = Number(cell.getRow().getIndex());
   if (column !== undefined && !send({ kind: "cell", row, column, value: String(cell.getValue()) })) {
      cell.restoreOldValue();
   }
   refreshControls();
});

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
            await render(data.snapshot);
         } finally {
            queuedSnapshots--;
         }
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

function asText(value: string): HTMLElement {
   const span = document.createElement("span");
   span.textContent = value;
   return span;
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

function moveSelection(vertical: boolean, direction: Direction): void {
   if (!snapshot) {
      return;
   }
   if (vertical && hasViewOrder()) {
      notice = "Clear sorting and filters before moving a row.";
      refreshControls();
   } else if (vertical && selectedRow !== undefined) {
      const next = selectedRow + direction;
      if (next >= 1 && next <= snapshot.records.length && send({ kind: "moveRow", row: selectedRow, direction })) {
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

function applyColumns(next: Snapshot): void {
   const headers = Array.from({ length: next.columnCount }, (_, index) => next.header?.values[index] ?? "");
   const key = JSON.stringify([headers, frozenCount]);
   if (key === renderedColumns) {
      return;
   }
   renderedColumns = key;
   const sorters = table.getSorters()
      .filter(({ field }) => (columnIndex(field) ?? Infinity) < headers.length)
      .map(({ field, dir }) => ({ column: field, dir }));
   const filters = table.getHeaderFilters().filter(({ field }) => (columnIndex(field) ?? Infinity) < headers.length);
   const stub: ColumnDefinition = {
      title: "#",
      titleFormatter: () => gutter.header(),
      field: "_line",
      frozen: true,
      width: 74,
      headerSort: false,
      resizable: false,
      hozAlign: "right",
      cssClass: "gutter-cell",
      formatter: (cell) => gutter.record({ id: Number(cell.getRow().getIndex()), line: Number(cell.getValue()) }),
   };
   const columns: ColumnDefinition[] = headers.map((name, index) => {
      const field = `c${index}`;
      return {
         title: `Column ${index + 1}`,
         titleFormatter: () => asText(name || `Column ${index + 1}`),
         field,
         sorter: "string",
         headerSortTristate: true,
         frozen: index < frozenCount,
         width: widths.get(field) ?? 170,
         minWidth: 80,
         formatter: (cell) => asText(String(cell.getValue() ?? "")),
         cssClass: "data-cell",
         variableHeight: true,
         editor: "textarea",
         editorParams: () => ({ enterSubmit: true, shiftEnterNewLine: true, verticalNavigation: "editor" }),
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
   if (selectedRow !== undefined && selectedRow > next.records.length) {
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
   const selected = selectedRow === undefined ? undefined : snapshot.records[selectedRow - 1];
   const summary = [
      `${snapshot.records.length} data rows · ${snapshot.columnCount} columns`,
      selected && `Line ${selected.line}`,
      selectedColumn !== undefined && `Column ${selectedColumn + 1}`,
   ]
      .filter(Boolean)
      .join(" · ");
   statusElement.textContent = snapshot.error ?? (notice || summary);
}

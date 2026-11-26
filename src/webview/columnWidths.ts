import type { Snapshot } from "../shared/messages";

export function measureInitialWidths(table: HTMLElement, snapshot: Snapshot, widths: Map<string, number>): void {
   const fields = Array.from({ length: snapshot.columnCount }, (_, index) => `c${index}`);
   if (fields.every((field) => widths.has(field))) {
      return;
   }

   const maximum = snapshot.cellMaxWidth;
   const minimum = Math.min(80, maximum);
   const measure = createTextMeasurer(table);
   // 按源文件顺序取样。只有表头时，用表头文本作为测宽依据。
   const rows = snapshot.records.length ? snapshot.records.slice(0, 100) : snapshot.header ? [snapshot.header] : [];

   fields.forEach((field, index) => {
      if (widths.has(field)) {
         return;
      }
      let width = minimum;
      for (const row of rows) {
         width = Math.max(width, measure(row.values[index] ?? ""));
         if (width >= maximum) {
            break;
         }
      }
      widths.set(field, Math.min(Math.ceil(width), maximum));
   });
}

function createTextMeasurer(table: HTMLElement): (value: string) => number {
   const canvas = document.createElement("canvas").getContext("2d");
   if (!canvas) {
      return () => 0;
   }

   // 读取实际单元格的字体和留白，沿用当前 VS Code 主题及表格样式。
   const row = document.createElement("div");
   row.className = "tabulator-row";
   row.style.position = "absolute";
   row.style.visibility = "hidden";
   const cell = document.createElement("div");
   cell.className = "tabulator-cell data-cell";
   row.append(cell);
   table.append(row);
   const style = getComputedStyle(cell);
   canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
   const padding = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth].reduce(
      (total, value) => total + (Number.parseFloat(value) || 0),
      0,
   );
   const tabSize = style.getPropertyValue("tab-size").trim() || "8";
   const tabWidth = Math.max(
      1,
      tabSize.endsWith("px") ? Number.parseFloat(tabSize) : Number(tabSize) * canvas.measureText(" ").width,
   );
   row.remove();

   return (value) => {
      let widest = 0;
      for (const line of value.split(/\r\n|\n|\r/)) {
         const width = line.split("\t").reduce((previous, segment, index) => {
            const start = index === 0 ? 0 : (Math.floor(previous / tabWidth) + 1) * tabWidth;
            return start + canvas.measureText(segment).width;
         }, 0);
         widest = Math.max(widest, width);
      }
      return widest + padding;
   };
}

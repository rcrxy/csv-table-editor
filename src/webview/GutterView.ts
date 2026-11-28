import type { TabulatorFull } from "tabulator-tables";
import type { GitMarker, GitStatus, Gutter, RowNumberMode, TableRecord } from "../shared/messages";

type VisibleRowNumberMode = Exclude<RowNumberMode, "none">;

const statusNames: Record<GitStatus, string> = {
   added: "Added",
   modified: "Modified",
   deleted: "Deletion at this boundary",
};

interface RenderedRowPosition {
   index: number;
   top: number;
   bottom: number;
}

export class GutterView {
   // 按当前快照的记录 ID 保存标记。0 是首条记录，null 是文件末尾的删除边界。
   private markers = new Map<number | null, GitMarker[]>();
   private overviewMarkers: { row: number | null; button: HTMLButtonElement }[] = [];
   private displayPositions = new Map<number, number>();
   private headerRecord: number | undefined;
   private scheduleScrollTrack: (() => void) | undefined;

   constructor(
      private readonly table: TabulatorFull,
      private readonly tableElement: HTMLElement,
      private readonly overview: HTMLElement,
      private readonly end: HTMLElement,
      private readonly reveal: (row: number | null, line: number) => void,
   ) {}

   attachScrollTrack(): void {
      const viewport = this.tableElement.querySelector<HTMLElement>(".tabulator-tableholder");
      const content = viewport?.querySelector<HTMLElement>(".tabulator-table");
      const frozenRows = this.tableElement.querySelector<HTMLElement>(".tabulator-frozen-rows-holder");
      if (!viewport || !content) {
         return;
      }
      this.tableElement.append(this.overview);
      let frame: number | undefined;
      const schedule = () => {
         if (frame === undefined) {
            frame = requestAnimationFrame(() => {
               frame = undefined;
               this.layoutScrollTrack(viewport, content, frozenRows);
            });
         }
      };
      this.scheduleScrollTrack = schedule;
      const updateDisplayPositions = () => {
         this.displayPositions.clear();
         this.table.getRows("active").forEach((row, index) => {
            this.displayPositions.set(Number(row.getIndex()), index);
         });
         schedule();
      };
      this.table.on("renderComplete", updateDisplayPositions);
      this.table.on("scrollVertical", schedule);
      const observer = new ResizeObserver(schedule);
      observer.observe(viewport);
      observer.observe(content);
      if (frozenRows) {
         observer.observe(frozenRows);
      }
      updateDisplayPositions();
   }

   private layoutScrollTrack(viewport: HTMLElement, content: HTMLElement, frozenRows: HTMLElement | null): void {
      const trackHeight = viewport.clientHeight;
      const frozenHeight = frozenRows?.offsetHeight ?? 0;
      const scrollingHeight = content.offsetHeight;
      const contentHeight = frozenHeight + scrollingHeight;
      const positions = new Map<number, RenderedRowPosition>();
      // 冻结行位于表头容器内，概览仍按完整的记录顺序绘制。
      for (const container of [frozenRows, content]) {
         if (!container) {
            continue;
         }
         const origin = container.getBoundingClientRect().top;
         const offset = container === frozenRows ? 0 : frozenHeight;
         for (const element of container.children) {
            if (!(element instanceof HTMLElement) || element.dataset.recordId === undefined) {
               continue;
            }
            const id = Number(element.dataset.recordId);
            const index = this.displayPositions.get(id);
            if (index !== undefined) {
               const rect = element.getBoundingClientRect();
               const top = offset + rect.top - origin;
               positions.set(id, { index, top, bottom: top + rect.height });
            }
         }
      }
      const rendered = [...positions.values()];
      const first = rendered[0];
      const last = rendered.at(-1);
      // 短表在底部多留一行滚动空间，计算标记时仍以可见轨道高度为基准。
      if (first && scrollingHeight > 0 && scrollingHeight <= trackHeight) {
         viewport.style.setProperty("--table-scroll-end", `${trackHeight + first.bottom - first.top}px`);
      } else {
         viewport.style.removeProperty("--table-scroll-end");
      }
      // clientHeight 不包含横向滚动条。
      this.overview.style.top = `${viewport.offsetTop}px`;
      this.overview.style.left = `${viewport.offsetLeft + viewport.clientWidth}px`;
      this.overview.style.width = `${viewport.offsetWidth - viewport.clientWidth}px`;
      this.overview.style.height = `${trackHeight}px`;

      const rowCount = this.displayPositions.size;
      const scaleHeight = Math.max(1, trackHeight + frozenHeight, contentHeight);
      for (const { row, button } of this.overviewMarkers) {
         let offset = 0;
         if (row === null) {
            offset = contentHeight;
         } else if (row !== this.headerRecord) {
            const index = this.displayPositions.get(row);
            if (index === undefined) {
               button.hidden = true;
               continue;
            }
            const position = positions.get(row);
            // 虚拟列表只渲染部分记录，用已知行的边界估算其余记录的位置。
            if (position) {
               offset = (position.top + position.bottom) / 2;
            } else if (first && index < first.index) {
               offset = ((index + 0.5) / first.index) * first.top;
            } else if (last && index > last.index) {
               const afterLast = rowCount - last.index - 1;
               offset = last.bottom + ((index - last.index - 0.5) / afterLast) * (contentHeight - last.bottom);
            } else {
               offset = ((index + 0.5) / rowCount) * contentHeight;
            }
         }
         button.hidden = false;
         const top = (offset / scaleHeight) * trackHeight;
         button.style.top = `${Math.min(Math.max(top, 1.5), Math.max(1.5, trackHeight - 1.5))}px`;
      }
   }

   measureWidth(mode: VisibleRowNumberMode, recordDigits: number, sourceDigits: number): number {
      const sample = document.createElement("span");
      sample.className = "record-gutter";
      sample.style.position = "absolute";
      sample.style.visibility = "hidden";
      sample.style.boxSizing = "content-box";
      sample.style.minWidth = "4ch";
      sample.style.width = "max-content";
      sample.append(this.numbers(mode, "0".repeat(recordDigits), "0".repeat(sourceDigits)));
      this.tableElement.append(sample);
      const width = Math.ceil(sample.getBoundingClientRect().width);
      sample.remove();
      // 测量结果包含行号的留白，再计入单元格右侧边框。
      return width > 0 ? width + 1 : Math.max(4, recordDigits + sourceDigits) * 8 + 15;
   }

   record(record: Pick<TableRecord, "id" | "line">, sequence: number, mode: VisibleRowNumberMode): HTMLElement {
      const element = document.createElement("span");
      element.className = "record-gutter";
      element.append(this.numbers(mode, String(sequence), String(record.line)));
      this.paintMarkers(element, record.id, `Record ${sequence} · Source line ${record.line}`);
      return element;
   }

   header(): HTMLElement {
      const element = document.createElement("span");
      element.className = "record-gutter header-gutter";
      element.textContent = "#";
      this.paintMarkers(element, 0, "Header record");
      return element;
   }

   private numbers(mode: VisibleRowNumberMode, sequence: string, line: string): HTMLElement {
      const label = document.createElement("span");
      label.className = "row-number-label";
      label.textContent = mode === "source" ? line : sequence;
      if (mode === "both") {
         const source = document.createElement("span");
         source.className = "row-number-source";
         source.textContent = line;
         label.append(source);
      }
      return label;
   }

   update(gutter: Gutter | undefined, headerRecord?: number): void {
      const previous = this.markers;
      this.markers = new Map();
      this.headerRecord = headerRecord;
      this.overviewMarkers = [];
      const overview = document.createDocumentFragment();
      for (const marker of gutter?.markers ?? []) {
         const list = this.markers.get(marker.row) ?? [];
         list.push(marker);
         this.markers.set(marker.row, list);

         const button = document.createElement("button");
         button.className = `overview-marker ${marker.status}`;
         button.type = "button";
         button.title = `${statusNames[marker.status]} · line ${marker.line}`;
         button.setAttribute("aria-label", button.title);
         button.addEventListener("click", () => this.reveal(marker.row, marker.line));
         this.overviewMarkers.push({ row: marker.row, button });
         overview.append(button);
      }
      this.overview.replaceChildren(overview);
      this.overview.hidden = this.markers.size === 0;
      this.scheduleScrollTrack?.();

      const header = this.tableElement.querySelector<HTMLElement>(".header-gutter");
      if (header) {
         this.paintMarkers(header, 0);
      }
      // 更新新旧标记涉及的行，清除旧标记。尚未渲染的行会在格式化时读取当前标记。
      for (const id of new Set([...previous.keys(), ...this.markers.keys()])) {
         if (id === null || (id === 0 && header)) {
            continue;
         }
         const row = this.table.getRow(id);
         const element = row && row.getElement().querySelector<HTMLElement>(".record-gutter");
         if (element) {
            this.paintMarkers(element, id);
         }
      }
      this.end.hidden = !this.markers.has(null);
      this.end.textContent = "Deletion at end of file";
      this.paintMarkers(this.end, null, "End of file");
   }

   private paintMarkers(element: HTMLElement, row: number | null, label = element.dataset.label ?? ""): void {
      const markers = this.markers.get(row) ?? [];
      const statuses = [...new Set(markers.map(({ status }) => status))];
      element.dataset.label = label;
      element.title = [label, ...statuses.map((status) => statusNames[status])].join(" · ");
      element.querySelectorAll(":scope > .gutter-strip").forEach((strip) => strip.remove());
      const strips = document.createDocumentFragment();
      for (const status of statuses) {
         const strip = document.createElement("span");
         strip.className = `gutter-strip ${status}`;
         strip.setAttribute("aria-hidden", "true");
         strips.append(strip);
      }
      element.prepend(strips);
   }
}

import type { TabulatorFull } from "tabulator-tables";
import type { GitMarker, GitStatus, Gutter, TableRecord } from "../shared/messages";

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
      if (!viewport || !content) {
         return;
      }
      this.tableElement.append(this.overview);
      let frame: number | undefined;
      const schedule = () => {
         if (frame === undefined) {
            frame = requestAnimationFrame(() => {
               frame = undefined;
               this.layoutScrollTrack(viewport, content);
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
      updateDisplayPositions();
   }

   private layoutScrollTrack(viewport: HTMLElement, content: HTMLElement): void {
      const trackHeight = viewport.clientHeight;
      const contentHeight = content.offsetHeight;
      const positions = new Map<number, RenderedRowPosition>();
      for (const element of content.children) {
         if (!(element instanceof HTMLElement) || element.dataset.recordId === undefined) {
            continue;
         }
         const id = Number(element.dataset.recordId);
         const index = this.displayPositions.get(id);
         if (index !== undefined) {
            const top = element.offsetTop;
            positions.set(id, { index, top, bottom: top + element.offsetHeight });
         }
      }
      const rendered = [...positions.values()];
      const first = rendered[0];
      const last = rendered.at(-1);
      // 短表在底部多留一行滚动空间，计算标记时仍以可见轨道高度为基准。
      if (first && contentHeight <= trackHeight) {
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
      const scaleHeight = Math.max(1, trackHeight, contentHeight);
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

   measureWidth(digits: number): number {
      const sample = document.createElement("span");
      sample.className = "record-gutter";
      sample.style.position = "absolute";
      sample.style.visibility = "hidden";
      sample.style.boxSizing = "content-box";
      sample.style.width = `${digits}ch`;
      this.tableElement.append(sample);
      const width = Math.ceil(sample.getBoundingClientRect().width);
      sample.remove();
      // 测量结果包含行号的留白，再计入单元格右侧边框。
      return width > 0 ? width + 1 : digits * 8 + 15;
   }

   record(record: Pick<TableRecord, "id" | "line">): HTMLElement {
      const element = document.createElement("span");
      element.className = "record-gutter";
      this.paint(element, record.id, String(record.line), `Source line ${record.line}`);
      return element;
   }

   header(): HTMLElement {
      const element = document.createElement("span");
      element.className = "record-gutter header-gutter";
      this.paint(element, 0, "#", "Header record");
      return element;
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
         this.paint(header, 0, "#", "Header record");
      }
      // 更新新旧标记涉及的行，清除旧标记。尚未渲染的行会在格式化时读取当前标记。
      for (const id of new Set([...previous.keys(), ...this.markers.keys()])) {
         if (id === null || (id === 0 && header)) {
            continue;
         }
         const row = this.table.getRow(id);
         const element = row && row.getElement().querySelector<HTMLElement>(".record-gutter");
         if (element) {
            const line = Number(element.dataset.line);
            this.paint(element, id, String(line), `Source line ${line}`);
         }
      }
      this.end.hidden = !this.markers.has(null);
      this.paint(this.end, null, "Deletion at end of file", "End of file");
   }

   private paint(element: HTMLElement, row: number | null, text: string, label: string): void {
      const markers = this.markers.get(row) ?? [];
      const statuses = [...new Set(markers.map(({ status }) => status))];
      element.dataset.line = text;
      element.title = [label, ...statuses.map((status) => statusNames[status])].join(" · ");
      element.replaceChildren();
      for (const status of statuses) {
         const strip = document.createElement("span");
         strip.className = `gutter-strip ${status}`;
         strip.setAttribute("aria-hidden", "true");
         element.append(strip);
      }
      element.append(document.createTextNode(text));
   }
}

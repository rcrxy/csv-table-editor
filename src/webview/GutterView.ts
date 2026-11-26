import type { TabulatorFull } from "tabulator-tables";
import type { GitMarker, GitStatus, Gutter, TableRecord } from "../shared/messages";

const statusNames: Record<GitStatus, string> = {
   added: "Added",
   modified: "Modified",
   deleted: "Deletion at this boundary",
};

export class GutterView {
   private markers = new Map<number | null, GitMarker[]>();

   constructor(
      private readonly table: TabulatorFull,
      private readonly tableElement: HTMLElement,
      private readonly overview: HTMLElement,
      private readonly end: HTMLElement,
      private readonly reveal: (row: number | null, line: number) => void,
   ) {}

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

   update(gutter: Gutter | undefined): void {
      const previous = this.markers;
      this.markers = new Map();
      const overview = document.createDocumentFragment();
      const lineCount = Math.max(1, gutter?.lineCount ?? 1);
      for (const marker of gutter?.markers ?? []) {
         const list = this.markers.get(marker.row) ?? [];
         list.push(marker);
         this.markers.set(marker.row, list);

         const button = document.createElement("button");
         button.className = `overview-marker ${marker.status}`;
         button.type = "button";
         button.title = `${statusNames[marker.status]} · line ${marker.line}`;
         button.setAttribute("aria-label", button.title);
         button.style.top = `${((marker.line - 0.5) / lineCount) * 100}%`;
         button.addEventListener("click", () => this.reveal(marker.row, marker.line));
         overview.append(button);
      }
      this.overview.replaceChildren(overview);
      this.overview.hidden = this.markers.size === 0;

      const header = this.tableElement.querySelector<HTMLElement>(".header-gutter");
      if (header) {
         this.paint(header, 0, "#", "Header record");
      }
      for (const id of new Set([...previous.keys(), ...this.markers.keys()])) {
         if (id === 0 || id === null) {
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

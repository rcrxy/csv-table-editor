import type { ColumnComponent } from "tabulator-tables";

const edgeZone = 24;
const edgeGrowthPerMs = 0.36;

export function attachLastColumnResize(
   column: ColumnComponent,
   viewport: HTMLElement,
   saveWidth: (column: ColumnComponent) => void,
): () => void {
   const handle = document.createElement("span");
   handle.className = "last-column-resize-handle";
   handle.setAttribute("aria-hidden", "true");
   column.getElement().append(handle);

   let finishDrag: (() => void) | undefined;
   handle.addEventListener("click", (event) => event.stopPropagation());
   handle.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      column.setWidth(true);
      saveWidth(column);
   });
   handle.addEventListener("pointerdown", (event) => {
      if (finishDrag || !event.isPrimary || event.button !== 0) {
         return;
      }
      event.preventDefault();
      const { pointerId } = event;
      const listeners = new AbortController();
      const { signal } = listeners;
      const originalWidth = column.getWidth();
      const minimumWidth = column.getDefinition().minWidth ?? 1;
      let width = originalWidth;
      let x = event.clientX;
      let y = event.clientY;
      let appliedX = x;
      let dragging = false;
      let frame: number | undefined;
      let previousTime: number | undefined;

      function updateWidth(delta: number): void {
         width = Math.max(minimumWidth, width + delta);
         const pixels = Math.round(width);
         if (pixels !== column.getWidth()) {
            column.setWidth(pixels);
         }
      }

      function resize(time: number): void {
         frame = undefined;
         const delta = x - appliedX;
         appliedX = x;
         const inside = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
         const right = viewport.getBoundingClientRect().left + viewport.clientLeft + viewport.clientWidth;
         const pressure = inside && delta >= 0 ? Math.min(1, (x - right + edgeZone) / edgeZone) : 0;
         const elapsed = previousTime === undefined ? 0 : Math.min(32, time - previousTime);
         updateWidth(delta + (pressure > 0 ? pressure * elapsed * edgeGrowthPerMs : 0));
         if (pressure > 0) {
            // 先增宽末列，再滚到新末尾，停在边缘时也有新的滚动空间。
            viewport.scrollLeft = viewport.scrollWidth - viewport.clientWidth;
            previousTime = time;
            frame = requestAnimationFrame(resize);
         } else {
            previousTime = undefined;
         }
      }

      function finish(): void {
         if (finishDrag !== finish) {
            return;
         }
         finishDrag = undefined;
         listeners.abort();
         if (frame !== undefined) {
            cancelAnimationFrame(frame);
         }
         if (handle.hasPointerCapture(pointerId)) {
            handle.releasePointerCapture(pointerId);
         }
         if (column.getWidth() !== originalWidth) {
            saveWidth(column);
         }
      }

      handle.setPointerCapture(pointerId);
      finishDrag = finish;
      window.addEventListener(
         "pointermove",
         (move) => {
            if (move.pointerId !== pointerId) {
               return;
            }
            if (!(move.buttons & 1)) {
               finish();
               return;
            }
            dragging ||= x !== move.clientX;
            x = move.clientX;
            y = move.clientY;
            if (dragging && frame === undefined) {
               frame = requestAnimationFrame(resize);
            }
         },
         { capture: true, signal },
      );
      window.addEventListener(
         "pointerup",
         (up) => {
            if (up.pointerId === pointerId) {
               const delta = x - appliedX;
               updateWidth(delta);
               if (delta > 0 && previousTime !== undefined) {
                  viewport.scrollLeft = viewport.scrollWidth - viewport.clientWidth;
               }
               finish();
            }
         },
         { capture: true, signal },
      );
      const finishForPointer = (end: PointerEvent) => {
         if (end.pointerId === pointerId) {
            finish();
         }
      };
      window.addEventListener("pointercancel", finishForPointer, { capture: true, signal });
      handle.addEventListener("lostpointercapture", finishForPointer, { signal });
      window.addEventListener("blur", finish, { signal });
      document.addEventListener(
         "visibilitychange",
         () => {
            if (document.hidden) {
               finish();
            }
         },
         { signal },
      );
   });

   return () => {
      finishDrag?.();
      handle.remove();
   };
}

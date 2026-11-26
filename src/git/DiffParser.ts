import type { ParsedDocument } from "../core/CsvParser";
import type { RecordSpan } from "../core/SourceScanner";
import type { GitMarker, Gutter } from "../shared/messages";

type LineChange =
   | { line: number; status: "added" | "modified" }
   | { line: number; status: "deleted"; oldStart: number; oldEnd: number };

export function parseDiff(patch: string): LineChange[] {
   const changes: LineChange[] = [];
   let cursor = 0;
   let oldCursor = 0;
   let oldRemaining = 0;
   let newRemaining = 0;
   let removed = 0;
   let added = 0;

   function flush(): void {
      const start = cursor - added;
      for (let i = 0; i < added; i++) {
         changes.push({ line: start + i, status: i < removed ? "modified" : "added" });
      }
      if (removed > added) {
         changes.push({ line: cursor, status: "deleted", oldStart: oldCursor - removed + added, oldEnd: oldCursor - 1 });
      }
      removed = 0;
      added = 0;
   }

   for (const line of patch.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
         flush();
         oldRemaining = Number(hunk[2] ?? 1);
         newRemaining = Number(hunk[4] ?? 1);
         oldCursor = Number(hunk[1]) + (oldRemaining === 0 ? 1 : 0);
         cursor = Number(hunk[3]) + (newRemaining === 0 ? 1 : 0);
      } else if (oldRemaining || newRemaining) {
         if (line.startsWith("-") && oldRemaining > 0) {
            removed++;
            oldRemaining--;
            oldCursor++;
         } else if (line.startsWith("+") && newRemaining > 0) {
            added++;
            newRemaining--;
            cursor++;
         } else if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
            flush();
            oldRemaining--;
            newRemaining--;
            cursor++;
            oldCursor++;
         }
         // The "\ No newline at end of file" annotation consumes neither side.
      }
   }
   flush();
   return changes;
}

export function mapChanges(document: ParsedDocument, changes: LineChange[], previousRows?: RecordSpan[]): Gutter {
   const { rows } = document;
   const last = rows.at(-1);
   const lineCount = last ? last.endLine + (last.eol ? 1 : 0) : 1;
   const records = new Map<number, GitMarker>();
   const boundaries = new Map<number | null, GitMarker>();
   let rowIndex = 0;
   let previousIndex = 0;

   function markRecord(index: number, line: number, status: "added" | "modified"): void {
      const row = rows[index];
      const existing = records.get(index);
      if (row && (!existing || (existing.status === "added" && status === "modified"))) {
         records.set(index, { row: index, line: Math.min(line, row.endLine), status });
      }
   }

   function markBoundary(line: number): void {
      const anchor = rowIndex < rows.length ? rowIndex : null;
      const marker: GitMarker = { row: anchor, line: Math.min(line, lineCount), status: "deleted" };
      boundaries.set(anchor, marker);
   }

   for (const change of changes) {
      while (rowIndex < rows.length && rows[rowIndex].endLine < change.line) {
         rowIndex++;
      }
      const row = rows[rowIndex];
      if (change.status !== "deleted") {
         if (row && change.line >= row.startLine) {
            markRecord(rowIndex, change.line, change.status);
         }
         continue;
      }
      const withinRecord = !!row && row.startLine < change.line;
      if (!previousRows) {
         if (withinRecord) {
            markRecord(rowIndex, change.line, "modified");
         } else {
            markBoundary(change.line);
         }
         continue;
      }
      while (previousIndex < previousRows.length && previousRows[previousIndex].endLine < change.oldStart) {
         previousIndex++;
      }
      for (let index = previousIndex; index < previousRows.length; index++) {
         const previous = previousRows[index];
         if (previous.startLine > change.oldEnd) {
            break;
         }
         if (previous.startLine < change.oldStart) {
            markRecord(withinRecord ? rowIndex : rowIndex - 1, change.line, "modified");
         } else if (previous.endLine > change.oldEnd) {
            markRecord(rowIndex, change.line, "modified");
         } else {
            markBoundary(change.line);
         }
      }
   }

   return { lineCount, markers: [...records.values(), ...boundaries.values()].sort((a, b) => a.line - b.line) };
}

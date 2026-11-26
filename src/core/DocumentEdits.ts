import type { Operation } from "../shared/messages";
import type { ParsedDocument } from "./CsvParser";

export interface TextReplacement {
   start: number;
   end: number;
   text: string;
}

export function encodeField(value: string, delimiter: string, quoted = false): string {
   if (quoted || value.includes(delimiter) || /["\r\n]/.test(value) || value.startsWith("\uFEFF")) {
      return `"${value.replaceAll('"', '""')}"`;
   }
   return value;
}

export function documentEdits(
   document: ParsedDocument,
   operation: Exclude<Operation, { kind: "rename" }>,
   tableHeader: boolean,
): TextReplacement[] {
   const { rows, delimiter, newline, text, columnCount, bomLength } = document;
   const firstDataRow = tableHeader ? 1 : 0;
   const last = rows.at(-1);
   if (operation.kind === "addRow") {
      if (!last) {
         const row = tableHeader ? `${encodeField("Column 1", delimiter)}${newline}""` : '""';
         return [{ start: bomLength, end: bomLength, text: row }];
      }
      const blank = columnCount === 1 && !last.eol ? '""' : delimiter.repeat(columnCount - 1);
      const insertion = last.eol ? blank + last.eol : newline + blank;
      return [{ start: text.length, end: text.length, text: insertion }];
   }
   if (operation.kind === "addColumn" && !last) {
      return [{ start: bomLength, end: bomLength, text: tableHeader ? encodeField("Column 1", delimiter) : '""' }];
   }

   if ("row" in operation) {
      const index = operation.row;
      const row = rows[index];
      if (!Number.isInteger(index) || !row || (index < firstDataRow && operation.kind !== "cell")) {
         throw new Error("Select a data record first.");
      }
      if (operation.kind === "deleteRow") {
         const previous = rows[index - 1];
         const start = !row.eol && previous && previous.start !== previous.end ? previous.end : row.start;
         return [{ start, end: row.end + row.eol.length, text: "" }];
      }
      if (operation.kind === "moveRow") {
         const destination = index + operation.direction;
         const other = rows[destination];
         if (!other || destination < firstDataRow) {
            return [];
         }
         const first = index < destination ? row : other;
         const second = index < destination ? other : row;
         const firstText = text.slice(first.start, first.end);
         let secondText = text.slice(second.start, second.end);
         if (first === rows[0] && secondText.startsWith("\uFEFF")) {
            const field = second.fields[0];
            secondText = encodeField(text.slice(field.start, field.end), delimiter) + text.slice(field.end, second.end);
         }
         return [
            {
               start: first.start,
               end: second.end,
               text: secondText + first.eol + (firstText || (second.eol ? "" : '""')),
            },
         ];
      }
      const { column, value } = operation;
      if (!Number.isInteger(column) || column < 0 || column >= columnCount) {
         throw new Error("The selected column no longer exists.");
      }
      const field = row.fields[column];
      if (field && row.values[column] === value) {
         return [];
      }
      if (!field) {
         const padding = delimiter.repeat(column - row.fields.length + 1);
         return [{ start: row.end, end: row.end, text: padding + encodeField(value, delimiter) }];
      }
      const emptyRecordAtEof = row.fields.length === 1 && !row.eol && value === "";
      const quoted = field.quoteEnd !== undefined || emptyRecordAtEof;
      return [{ start: field.start, end: field.quoteEnd ?? field.end, text: encodeField(value, delimiter, quoted) }];
   }

   const column = operation.kind === "addColumn" ? columnCount : operation.column;
   if (operation.kind !== "addColumn" && (!Number.isInteger(column) || column < 0 || column >= columnCount)) {
      throw new Error("Select a column first.");
   }
   if (operation.kind === "deleteColumn" && columnCount === 1) {
      throw new Error("The table must keep at least one column.");
   }
   const destination = operation.kind === "moveColumn" ? column + operation.direction : column;
   if (operation.kind === "moveColumn" && (destination < 0 || destination >= columnCount)) {
      return [];
   }

   const edits: TextReplacement[] = [];
   rows.forEach((row, index) => {
      const fields = row.fields;
      if (operation.kind === "addColumn") {
         const padding = delimiter.repeat(column - fields.length + 1);
         const name = tableHeader && index === 0 ? encodeField(`Column ${column + 1}`, delimiter) : "";
         edits.push({ start: row.end, end: row.end, text: padding + name });
         return;
      }
      if (operation.kind === "deleteColumn") {
         const removed = fields[column];
         if (!removed) {
            return;
         }
         const before = fields[column - 1];
         const after = fields[column + 1];
         const onlyRemaining = fields.length === 2 ? before ?? after : undefined;
         if ((!before && !after) || (!row.eol && onlyRemaining && onlyRemaining.start === onlyRemaining.end)) {
            edits.push({ start: row.start, end: row.end, text: row.eol ? "" : '""' });
         } else if (!before && after && index === 0 && text[after.start] === "\uFEFF") {
            const value = encodeField(text.slice(after.start, after.end), delimiter);
            edits.push({ start: row.start, end: after.end, text: value });
         } else if (after) {
            edits.push({ start: removed.start, end: after.start, text: "" });
         } else {
            edits.push({ start: before.end, end: removed.end, text: "" });
         }
         return;
      }
      const leftIndex = Math.min(column, destination);
      const left = fields[leftIndex];
      if (!left) {
         return;
      }
      const right = fields[leftIndex + 1];
      const end = right?.end ?? left.end;
      const leftText = text.slice(left.start, left.end);
      const rightText = right ? text.slice(right.start, right.end) : "";
      const first =
         index === 0 && leftIndex === 0 && rightText.startsWith("\uFEFF") ? encodeField(rightText, delimiter) : rightText;
      const replacement = first + delimiter + leftText;
      if (replacement !== text.slice(left.start, end)) {
         edits.push({ start: left.start, end, text: replacement });
      }
   });
   return edits;
}

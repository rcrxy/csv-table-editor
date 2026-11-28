import type { DocumentOperation } from "../shared/messages";
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

function emptyRecordAtEnd(columnCount: number, delimiter: string): string {
   // 给末列的空字段加引号，避免保存时裁掉整行或 TSV 的尾部分隔符。
   return delimiter.repeat(columnCount - 1) + '""';
}

function cellEdits(document: ParsedDocument, index: number, column: number, value: string): TextReplacement[] {
   const { rows, delimiter } = document;
   const row = rows[index];
   const field = row.fields[column];
   if (field && row.values[column] === value) {
      return [];
   }
   if (!field) {
      const padding = delimiter.repeat(column - row.fields.length + 1);
      return [{ start: row.end, end: row.end, text: padding + encodeField(value, delimiter) }];
   }
   // 保留文件末尾的空记录，并防止相邻的 CR 和 LF 合并成一个换行。
   const needsEmptyField = !row.eol || (row.eol === "\n" && rows[index - 1]?.eol === "\r");
   const quoted = field.quoteEnd !== undefined || (row.fields.length === 1 && value === "" && needsEmptyField);
   return [{ start: field.start, end: field.quoteEnd ?? field.end, text: encodeField(value, delimiter, quoted) }];
}

export function documentEdits(
   document: ParsedDocument,
   operation: DocumentOperation,
   tableHeader: boolean,
): TextReplacement[] {
   const { rows, delimiter, newline, text, columnCount, bomLength } = document;
   const firstDataRow = tableHeader ? 1 : 0;
   const last = rows.at(-1);
   if (operation.kind === "pasteColumn") {
      const { row, column, values } = operation;
      if (!last || !Number.isInteger(row) || row < 0 || row > rows.length) {
         throw new Error("Select a record first.");
      }
      if (!Number.isInteger(column) || column < 0 || column >= columnCount) {
         throw new Error("The selected column no longer exists.");
      }
      const existingCount = Math.min(values.length, rows.length - row);
      const edits = values.slice(0, existingCount).flatMap((value, index) => cellEdits(document, row + index, column, value));
      const overflow = values.slice(existingCount);
      if (overflow.length) {
         const before = delimiter.repeat(column);
         const after = delimiter.repeat(columnCount - column - 1);
         const eol = last.eol || newline;
         const blank = emptyRecordAtEnd(columnCount, delimiter);
         const records = overflow.map((value) => (value === "" ? blank : before + encodeField(value, delimiter) + after));
         const insertion = last.eol ? records.join(eol) + eol : eol + records.join(eol);
         // 文件最后一个字段也被修改时，将追加内容合并到同一个文本替换。
         const finalEdit = edits.at(-1);
         if (finalEdit?.end === text.length) {
            finalEdit.text += insertion;
         } else {
            edits.push({ start: text.length, end: text.length, text: insertion });
         }
      }
      return edits;
   }
   if (operation.kind === "addRow") {
      const index = operation.before ?? rows.length;
      if (!Number.isInteger(index) || index < Math.min(firstDataRow, rows.length) || index > rows.length) {
         throw new Error("Select a data record first.");
      }
      if (!last) {
         const row = tableHeader ? `${encodeField("Column 1", delimiter)}${newline}""` : '""';
         return [{ start: bomLength, end: bomLength, text: row }];
      }
      const following = rows[index];
      if (following) {
         // 为单列空记录加引号，避免混用换行符时相邻的换行合并。
         const blank = columnCount === 1 ? '""' : delimiter.repeat(columnCount - 1);
         return [{ start: following.start, end: following.start, text: blank + (following.eol || newline) }];
      }
      const blank = emptyRecordAtEnd(columnCount, delimiter);
      const insertion = last.eol ? blank + last.eol : newline + blank;
      return [{ start: text.length, end: text.length, text: insertion }];
   }

   if ("row" in operation) {
      const index = operation.row;
      const row = rows[index];
      if (!Number.isInteger(index) || !row || (index < firstDataRow && operation.kind !== "cell")) {
         throw new Error("Select a data record first.");
      }
      if (operation.kind === "deleteRow") {
         const next = rows[index + 1];
         // 移到文件开头的字段需要保留原有的 U+FEFF 内容。
         if (index === 0 && next && text[next.start] === "\uFEFF") {
            const first = next.fields[0];
            return [{ start: row.start, end: first.end, text: encodeField(text.slice(first.start, first.end), delimiter) }];
         }
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
      return cellEdits(document, index, column, value);
   }

   const addingColumn = operation.kind === "addColumn";
   const column = addingColumn ? (operation.before ?? columnCount) : operation.column;
   const lastColumn = addingColumn ? columnCount : columnCount - 1;
   if (!Number.isInteger(column) || column < 0 || column > lastColumn) {
      throw new Error("Select a column first.");
   }
   if (addingColumn && !last) {
      return [{ start: bomLength, end: bomLength, text: tableHeader ? encodeField("Column 1", delimiter) : '""' }];
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
      if (addingColumn) {
         const name = tableHeader && index === 0 ? encodeField(`Column ${columnCount + 1}`, delimiter) : "";
         const following = fields[column];
         if (following) {
            edits.push({ start: following.start, end: following.start, text: name + delimiter });
         } else {
            const padding = delimiter.repeat(column - fields.length + 1);
            edits.push({ start: row.end, end: row.end, text: padding + name });
         }
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

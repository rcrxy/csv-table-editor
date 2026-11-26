interface FieldSpan {
   start: number;
   end: number;
   quoteEnd?: number;
}

export interface RecordSpan {
   start: number;
   end: number;
   startLine: number;
   endLine: number;
   eol: string;
   fields: FieldSpan[];
}

export function newlineAt(text: string, offset: number): string {
   if (text[offset] === "\r") {
      return text[offset + 1] === "\n" ? "\r\n" : "\r";
   }
   return text[offset] === "\n" ? "\n" : "";
}

export function scanSource(text: string, delimiter: string, limit = Infinity): RecordSpan[] {
   const records: RecordSpan[] = [];
   let offset = text.startsWith("\uFEFF") ? 1 : 0;
   let line = 1;
   while (offset < text.length && records.length < limit) {
      const start = offset;
      const startLine = line;
      const fields: FieldSpan[] = [];
      for (;;) {
         const fieldStart = offset;
         let quoteEnd: number | undefined;
         if (text[offset] === '"') {
            offset++;
            while (offset < text.length) {
               if (text[offset] === '"') {
                  offset++;
                  if (text[offset] !== '"') {
                     quoteEnd = offset;
                     break;
                  }
                  offset++;
                  continue;
               }
               const eol = newlineAt(text, offset);
               if (eol) {
                  line++;
               }
               offset += eol.length || 1;
            }
            if (quoteEnd === undefined) {
               throw new Error(`Unclosed quoted field in record starting on line ${startLine}.`);
            }
            while (offset < text.length && !text.startsWith(delimiter, offset) && !newlineAt(text, offset)) {
               if (text[offset].trim()) {
                  throw new Error(`Unexpected text after a closing quote on line ${line}.`);
               }
               offset++;
            }
         } else {
            while (offset < text.length && !text.startsWith(delimiter, offset) && !newlineAt(text, offset)) {
               offset++;
            }
         }
         fields.push({ start: fieldStart, end: offset, quoteEnd });
         if (!text.startsWith(delimiter, offset)) {
            break;
         }
         offset += delimiter.length;
      }
      const eol = newlineAt(text, offset);
      records.push({ start, end: offset, startLine, endLine: line, eol, fields });
      offset += eol.length;
      line++;
   }
   return records;
}

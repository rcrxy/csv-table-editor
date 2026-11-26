import * as papa from "papaparse";
import { scanSource, type RecordSpan } from "./SourceScanner";

export interface ParsedDocument {
   text: string;
   delimiter: string;
   newline: string;
   bomLength: number;
   rows: (RecordSpan & { values: string[] })[];
   columnCount: number;
}

export const delimiters = [
   { label: "Comma (,)", value: "," },
   { label: "Tab", value: "\t" },
   { label: "Semicolon (;)", value: ";" },
   { label: "Pipe (|)", value: "|" },
];

export function delimiterError(value: string): string | undefined {
   if ([...value].length !== 1 || papa.BAD_DELIMITERS.includes(value) || value === "\0") {
      return "Enter a single character other than a quote, line break, BOM, or NUL.";
   }
}

export function detectDelimiter(text: string, fallback: string): string {
   const candidates = delimiters.filter(({ value }) => {
      try {
         const sample = scanSource(text, value, 30).filter(({ start, end }) => end > start);
         const width = sample[0]?.fields.length ?? 0;
         return sample.length >= 2 && width > 1 && sample.every(({ fields }) => fields.length === width);
      } catch {
         return false;
      }
   });
   return candidates.length === 1 ? candidates[0].value : fallback;
}

export function parseDocument(text: string, delimiter: string, defaultNewline: string): ParsedDocument {
   const records = scanSource(text, delimiter);
   // Normalize only record separators for Papa Parse. Sentinels preserve both an empty record
   // and any BOM character within the first field. Offsets always point into the original text.
   const input = "\n" + records.map(({ start, end }) => text.slice(start, end)).join("\n") + "\n";
   const { data, errors } = papa.parse<string[]>(input, {
      delimiter,
      newline: "\n",
      quoteChar: '"',
      escapeChar: '"',
      dynamicTyping: false,
      skipEmptyLines: false,
   });
   const values = records.length ? data.slice(1, -1) : [];
   if (errors.length || values.length !== records.length) {
      throw new Error("CSV parsing does not match the source records. Check quoting or choose a different delimiter.");
   }
   let columnCount = 0;
   const rows = records.map((record, index) => {
      const row = values[index];
      if (row.length !== record.fields.length) {
         throw new Error(`Field positions do not match the parsed values on line ${record.startLine}.`);
      }
      for (let fieldIndex = 0; fieldIndex < row.length; fieldIndex++) {
         const field = record.fields[fieldIndex];
         const source =
            field.quoteEnd === undefined
               ? text.slice(field.start, field.end)
               : text.slice(field.start + 1, field.quoteEnd - 1).replaceAll('""', '"');
         if (row[fieldIndex] !== source) {
            throw new Error(`Field positions do not match the parsed values on line ${record.startLine}.`);
         }
      }
      columnCount = Math.max(columnCount, row.length);
      return { ...record, values: row };
   });
   return {
      text,
      delimiter,
      rows,
      columnCount,
      bomLength: text.startsWith("\uFEFF") ? 1 : 0,
      newline: records.find(({ eol }) => eol)?.eol ?? defaultNewline,
   };
}

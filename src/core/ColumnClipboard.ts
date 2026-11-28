import type { Snapshot } from "../shared/messages";
import { encodeField } from "./DocumentEdits";

export function formatClipboardColumn(snapshot: Snapshot, column: number): string {
   const values = snapshot.records
      .filter((record) => record.id !== snapshot.placeholderRow)
      .map((record) => record.values[column] ?? "");
   if (snapshot.header && snapshot.header.id !== snapshot.placeholderRow) {
      values.unshift(snapshot.header.values[column] ?? "");
   }
   // 单列 TSV 保留字段里的换行、制表符以及列尾的空单元格。
   return values.map((value, index) => encodeField(value, "\t", value === "" && index === values.length - 1)).join("\n");
}

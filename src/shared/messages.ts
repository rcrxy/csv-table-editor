export type Direction = -1 | 1;

export type Operation =
   | { kind: "cell"; row: number; column: number; value: string }
   | { kind: "rename"; column: number }
   | { kind: "addRow" }
   | { kind: "deleteRow"; row: number }
   | { kind: "moveRow"; row: number; direction: Direction }
   | { kind: "addColumn" }
   | { kind: "deleteColumn"; column: number }
   | { kind: "moveColumn"; column: number; direction: Direction };

export type WebviewMessage =
   | { type: "ready" }
   | { type: "delimiter" }
   | { type: "columnResized"; column: number; width: number }
   | { type: "edit"; revision: number; version: number; operation: Operation };

export interface TableRecord {
   id: number;
   line: number;
   values: string[];
}

export interface Snapshot {
   revision: number;
   version: number;
   delimiter: string;
   autoDelimiter: boolean;
   cellMaxWidth: number;
   tableHeader: boolean;
   columnCount: number;
   header: TableRecord | undefined;
   records: TableRecord[];
   error?: string;
}

export type GitStatus = "added" | "modified" | "deleted";

export interface GitMarker {
   row: number | null;
   line: number;
   status: GitStatus;
}

export interface Gutter {
   lineCount: number;
   markers: GitMarker[];
}

export type HostMessage =
   | { type: "snapshot"; snapshot: Snapshot; savedColumnWidths?: Record<string, number> }
   | { type: "textWrapping"; enabled: boolean }
   | { type: "editResult"; revision: number; error?: string }
   | { type: "gutter"; revision: number; gutter?: Gutter };

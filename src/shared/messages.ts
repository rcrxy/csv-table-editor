export type Direction = -1 | 1;

export type TableDirection = "up" | "down" | "left" | "right";
export type KeyboardMode = "inactive" | "grid" | "editing";
export type StructureMenuCommand =
   | "insertRowAbove"
   | "insertRowBelow"
   | "insertColumnLeft"
   | "insertColumnRight"
   | "deleteRow"
   | "deleteColumn";

export type TableAction =
   | { kind: "moveCellSelection" | "moveTableStructure"; direction: TableDirection }
   | { kind: "editCell"; target?: { row: number; column: number; revision: number; version: number } }
   | { kind: "prepareCacheReload" }
   | {
        kind: "editStructureFromMenu";
        command: StructureMenuCommand;
        target: { field?: string; rowId?: number; revision: number; version: number };
     }
   | { kind: "submitCellEdit"; save: boolean };

export type Operation =
   | { kind: "cell"; row: number; column: number; value: string }
   | { kind: "rename"; column: number }
   | { kind: "addRow"; before?: number }
   | { kind: "deleteRow"; row: number }
   | { kind: "moveRow"; row: number; direction: Direction }
   | { kind: "addColumn"; before?: number }
   | { kind: "deleteColumn"; column: number }
   | { kind: "moveColumn"; column: number; direction: Direction };

export type WebviewMessage =
   | { type: "ready" }
   | { type: "delimiter" }
   | { type: "clearAndReload" }
   | { type: "keyboardMode"; mode: KeyboardMode; hasSelectedCell: boolean }
   | { type: "columnResized"; column: number; width: number }
   | { type: "save"; revision: number; version: number }
   | { type: "edit"; revision: number; version: number; operation: Operation; save?: boolean };

export interface TableRecord {
   id: number;
   line: number;
   values: string[];
}

export interface Snapshot {
   revision: number;
   version: number;
   resource: string;
   delimiter: string;
   autoDelimiter: boolean;
   cellMaxWidth: number;
   tableHeader: boolean;
   showRowNumbers: boolean;
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
   | { type: "tableAction"; action: TableAction }
   | { type: "editResult"; revision: number; error?: string }
   | { type: "gutter"; revision: number; gutter?: Gutter };

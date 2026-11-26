import { isAbsolute, relative, sep } from "node:path";
import * as vscode from "vscode";
import type { ParsedDocument } from "../core/CsvParser";
import { scanSource, type RecordSpan } from "../core/SourceScanner";
import type { Gutter, HostMessage } from "../shared/messages";
import { mapChanges, parseDiff } from "./DiffParser";

interface GitChange {
   readonly uri: vscode.Uri;
   readonly status: number;
}

interface GitRepository {
   readonly rootUri: vscode.Uri;
   readonly state: {
      readonly onDidChange: vscode.Event<void>;
      readonly HEAD?: { readonly commit?: string };
      readonly indexChanges: GitChange[];
      readonly workingTreeChanges: GitChange[];
      readonly untrackedChanges: GitChange[];
   };
   diffWith(ref: string, path: string): Promise<string>;
   show(ref: string, path: string): Promise<string>;
}

interface GitApi {
   readonly onDidOpenRepository: vscode.Event<GitRepository>;
   readonly onDidCloseRepository: vscode.Event<GitRepository>;
   getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
   readonly enabled: boolean;
   readonly onDidChangeEnablement: vscode.Event<boolean>;
   getAPI(version: 1): GitApi;
}

// Status values exposed by version 1 of the built-in Git extension API.
const indexAdded = 1;
const untracked = 7;

export class GitGutter implements vscode.Disposable {
   private api: GitApi | undefined;
   private repository: GitRepository | null = null;
   private repositoryListener: vscode.Disposable | undefined;
   private extensionListener: vscode.Disposable | undefined;
   private apiListeners: vscode.Disposable[] = [];
   private timer: ReturnType<typeof setTimeout> | undefined;
   private generation = 0;
   private disposed = false;

   constructor(
      private readonly document: vscode.TextDocument,
      private readonly current: () => { parsed: ParsedDocument | undefined; revision: number },
      private readonly publish: (message: Extract<HostMessage, { type: "gutter" }>) => void,
   ) {
      void this.bindGit();
   }

   schedule(): void {
      if (this.disposed) {
         return;
      }
      clearTimeout(this.timer);
      const generation = ++this.generation;
      this.timer = setTimeout(() => void this.refresh(generation), 250);
   }

   dispose(): void {
      this.disposed = true;
      clearTimeout(this.timer);
      this.extensionListener?.dispose();
      this.repositoryListener?.dispose();
      this.apiListeners.forEach((listener) => listener.dispose());
   }

   private async bindGit(): Promise<void> {
      const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
      if (!extension || this.document.uri.scheme !== "file") {
         return;
      }
      try {
         const git = extension.isActive ? extension.exports : await extension.activate();
         if (this.disposed || !git) {
            return;
         }
         this.extensionListener = git.onDidChangeEnablement(() => this.useApi(git));
         this.useApi(git);
      } catch {
         // Git integration is optional for all table operations.
      }
   }

   private useApi(git: GitExtension): void {
      this.apiListeners.forEach((listener) => listener.dispose());
      this.apiListeners = [];
      this.api = undefined;
      try {
         if (git.enabled) {
            this.api = git.getAPI(1);
            this.apiListeners = [
               this.api.onDidOpenRepository(() => this.schedule()),
               this.api.onDidCloseRepository(() => this.schedule()),
            ];
         }
      } catch {
         this.api = undefined;
      }
      this.schedule();
   }

   private async refresh(generation: number): Promise<void> {
      const { parsed, revision } = this.current();
      let gutter: Gutter | undefined;
      try {
         const repository = this.api?.getRepository(this.document.uri) ?? null;
         if (repository !== this.repository) {
            this.repositoryListener?.dispose();
            this.repository = repository;
            this.repositoryListener = repository?.state.onDidChange(() => this.schedule());
         }
         if (repository && parsed) {
            gutter = await this.readChanges(repository, parsed);
         }
      } catch {
         // Missing or unavailable Git data leaves the table usable.
      }
      if (!this.disposed && generation === this.generation && revision === this.current().revision) {
         this.publish({ type: "gutter", revision, gutter });
      }
   }

   private async readChanges(repository: GitRepository, parsed: ParsedDocument): Promise<Gutter | undefined> {
      const path = relative(repository.rootUri.fsPath, this.document.uri.fsPath);
      if (!path || isAbsolute(path) || path === ".." || path.startsWith(".." + sep)) {
         return;
      }
      const { state } = repository;
      const matches = (change: GitChange) => relative(change.uri.fsPath, this.document.uri.fsPath) === "";
      const isNew =
         state.untrackedChanges.some(matches) ||
         state.workingTreeChanges.some((change) => change.status === untracked && matches(change)) ||
         (!state.HEAD?.commit && state.indexChanges.some((change) => change.status === indexAdded && matches(change)));
      if (isNew) {
         return mapChanges(parsed, parsed.rows.map(({ startLine }) => ({ line: startLine, status: "added" })));
      }
      // Git's worktree patch refers to the saved file. Its line numbers can diverge from a dirty buffer.
      if (this.document.isDirty) {
         return;
      }
      const relativePath = path.split(sep).join("/");
      const changes = parseDiff(await repository.diffWith("HEAD", `:(literal)${relativePath}`));
      let previousRows: RecordSpan[] | undefined;
      if (changes.some(({ status }) => status === "deleted")) {
         try {
            previousRows = scanSource(await repository.show("HEAD", relativePath), parsed.delimiter);
         } catch {
            // If HEAD cannot be parsed with this delimiter, anchor deletions using the current records.
         }
      }
      return mapChanges(parsed, changes, previousRows);
   }
}

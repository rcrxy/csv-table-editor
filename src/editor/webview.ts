import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function configureWebview(webview: vscode.Webview, extensionUri: vscode.Uri): void {
   const dist = vscode.Uri.joinPath(extensionUri, "dist");
   const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
   const styles = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
   const nonce = randomBytes(16).toString("hex");
   webview.options = { enableScripts: true, localResourceRoots: [dist] };
   webview.html = `<!doctype html>
<html lang="en">
<head>
   <meta charset="utf-8">
   <meta name="viewport" content="width=device-width, initial-scale=1">
   <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
   <link rel="stylesheet" href="${styles}">
   <title>CSV Table Editor</title>
</head>
<body>
   <div id="toolbar" role="toolbar" aria-label="Table actions">
      <button id="delimiter" type="button" title="Change delimiter">Delimiter</button>
      <div class="actions" role="group" aria-label="Row actions">
         <button id="add-row" type="button">Add row</button>
         <button id="delete-row" type="button">Delete row</button>
      </div>
      <div class="actions" role="group" aria-label="Column actions">
         <button id="add-column" type="button">Add column</button>
         <button id="delete-column" type="button">Delete column</button>
         <button id="rename" type="button">Rename column</button>
         <button id="freeze" type="button" title="Freeze all columns through the selected column">Freeze through column</button>
      </div>
      <button id="reset-view" type="button">Clear sort and filters</button>
   </div>
   <div id="status" role="status" aria-live="polite">Reading document…</div>
   <main id="workspace">
      <div id="table" tabindex="0" aria-label="CSV table"></div>
      <div id="overview" role="group" aria-label="Git changes in file" hidden></div>
   </main>
   <div id="end-markers" hidden></div>
   <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

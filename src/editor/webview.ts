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
   <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

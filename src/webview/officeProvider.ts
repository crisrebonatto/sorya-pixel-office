import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StateStore, OfficeSnapshot } from '../core/stateStore';

/**
 * A webview é isolada: só recebe postMessage da extensão, nunca fala com
 * a rede (CSP sem connect-src). retainContextWhenHidden mantém o
 * escritório vivo quando você troca de aba — custa memória, mas sem isso
 * a experiência quebra de um jeito que o usuário percebe na hora.
 */
export class OfficeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentOffice.office';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: StateStore
  ) {
    store.on('change', (snapshot: OfficeSnapshot) => {
      this.view?.webview.postMessage({ type: 'state', state: snapshot });
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    // retainContextWhenHidden é definido no registro do provider,
    // em extension.ts.

    webviewView.webview.html = this.render(webviewView.webview);
    webviewView.webview.postMessage({ type: 'state', state: this.store.snapshot() });

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'ready') {
        webviewView.webview.postMessage({ type: 'state', state: this.store.snapshot() });
      }
    });
  }

  private render(webview: vscode.Webview): string {
    const mediaPath = path.join(this.extensionUri.fsPath, 'media');
    const html = fs.readFileSync(path.join(mediaPath, 'office.html'), 'utf8');
    const nonce = crypto.randomBytes(16).toString('base64');
    const mediaUri = webview.asWebviewUri(vscode.Uri.file(mediaPath));

    // Sem connect-src: a webview não fala com a rede.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return html
      .replaceAll('{{csp}}', csp)
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{media}}', mediaUri.toString());
  }
}

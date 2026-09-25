import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StateStore } from '../core/stateStore';
import { OfficeSnapshot } from '../core/types';

/**
 * A webview é isolada: só recebe postMessage da extensão, nunca fala com a
 * rede (CSP sem connect-src). O mesmo escritório pode estar na barra
 * lateral e num painel grande do editor ao mesmo tempo — os dois recebem o
 * mesmo snapshot.
 */
export class OfficeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'agentOffice.office';
  private webviews = new Set<vscode.Webview>();
  private panel: vscode.WebviewPanel | undefined;
  private last: OfficeSnapshot | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: StateStore,
    private readonly extras: () => Record<string, unknown>,
    private readonly onMessage: (msg: { type?: string; agentId?: string }) => void
  ) {
    store.on('change', (snapshot: OfficeSnapshot) => {
      this.last = snapshot;
      this.post({ type: 'state', state: this.decorate(snapshot) });
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview);
    view.onDidDispose(() => this.webviews.delete(view.webview));
  }

  /** Abre (ou revela) o escritório num painel grande do editor. */
  openPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('agentOffice.panel', 'Agent Office', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    this.attach(this.panel.webview);
    this.panel.onDidDispose(() => {
      if (this.panel) this.webviews.delete(this.panel.webview);
      this.panel = undefined;
    });
  }

  post(message: unknown): void {
    for (const w of this.webviews) void w.postMessage(message);
  }

  private decorate(s: OfficeSnapshot): OfficeSnapshot & Record<string, unknown> {
    return Object.assign({}, s, this.extras());
  }

  private attach(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    webview.html = this.render(webview);
    this.webviews.add(webview);
    webview.onDidReceiveMessage((message) => {
      if (message && message.type === 'ready') {
        void webview.postMessage({ type: 'state', state: this.decorate(this.last || this.store.snapshot()) });
      }
      this.onMessage(message || {});
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
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return html.replaceAll('{{csp}}', csp).replaceAll('{{nonce}}', nonce).replaceAll('{{media}}', mediaUri.toString());
  }
}

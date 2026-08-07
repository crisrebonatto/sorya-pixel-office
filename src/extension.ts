import * as vscode from 'vscode';
import { getOrCreateToken } from './server/auth';
import { startEventServer, EventServer } from './server/httpServer';
import { StateStore } from './core/stateStore';
import { EventRouter } from './core/eventRouter';
import { normalizeClaudeEvent } from './adapters/claudeCode';
import { runCodexTask, CodexRun } from './adapters/codex';
import { OfficeViewProvider } from './webview/officeProvider';
import { Agent } from './core/types';

let server: EventServer | undefined;
const codexRuns: CodexRun[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('agentOffice');
  const deskCount = config.get<number>('desks', 8);
  const preferredPort = config.get<number>('port', 4517);

  const store = new StateStore(deskCount);
  const router = new EventRouter(store);

  // O estado `waiting` é o único acionável — merece notificação nativa.
  store.on('waiting', (agent: Agent) => {
    if (vscode.workspace.getConfiguration('agentOffice').get<boolean>('notifyOnWaiting', true)) {
      void vscode.window.showWarningMessage(`Agent Office: ${agent.label} precisa de você.`);
    }
  });

  const token = await getOrCreateToken(context);
  try {
    server = await startEventServer(preferredPort, token, (payload) => {
      const event = normalizeClaudeEvent(payload);
      if (event) {
        router.route(event);
      }
    });
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Agent Office: não foi possível subir o servidor local de eventos (${String(err)}).`
    );
  }

  // Exporta token e porta REAL para os terminais integrados: é daqui que
  // o hook do Claude Code interpola $AGENT_OFFICE_TOKEN e $AGENT_OFFICE_PORT.
  context.environmentVariableCollection.replace('AGENT_OFFICE_TOKEN', token);
  if (server) {
    context.environmentVariableCollection.replace('AGENT_OFFICE_PORT', String(server.port));
  }

  const provider = new OfficeViewProvider(context.extensionUri, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OfficeViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentOffice.showStatus', () => {
      const status = server
        ? `escutando em 127.0.0.1:${server.port}`
        : 'servidor parado';
      void vscode.window.showInformationMessage(`Agent Office: ${status}.`);
    }),

    vscode.commands.registerCommand('agentOffice.delegateToCodex', async () => {
      const prompt = await vscode.window.showInputBox({
        title: 'Delegar ao Codex',
        prompt: 'O que o Codex deve fazer?'
      });
      if (!prompt) {
        return;
      }
      const command = vscode.workspace
        .getConfiguration('agentOffice')
        .get<string>('codexCommand', 'codex');
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      codexRuns.push(runCodexTask(command, prompt, cwd, (event) => router.route(event)));
    })
  );
}

export function deactivate(): void {
  server?.dispose();
  for (const run of codexRuns) {
    run.dispose();
  }
}

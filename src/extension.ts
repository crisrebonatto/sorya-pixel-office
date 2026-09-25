import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getOrCreateToken, VIEW_TOKEN_KEY } from './server/auth';
import { EventServer, relayEvent, startEventServer } from './server/httpServer';
import { createOfficeWeb, OfficeWeb } from './server/officeWeb';
import { installHookScript, otherEndpoints, removeEndpoint, writeEndpoint } from './server/discovery';
import { StateStore } from './core/stateStore';
import { EventRouter } from './core/eventRouter';
import { NameDirectory } from './core/names';
import { Agent, AgentSource, NormalizedEvent, SOURCE_LABEL } from './core/types';
import { normalizeHook, parseSource } from './adapters/hooks';
import { runCodexTask, CodexRun } from './adapters/codex';
import { ClaudeWatcher, claudeHome } from './watchers/claude';
import { projectOf, projectRootOf, seenCwds } from './watchers/tailer';
import { CodexWatcher, codexHome } from './watchers/codex';
import { GeminiWatcher, geminiHome } from './watchers/gemini';
import { AntigravityWatcher, antigravityRoots } from './watchers/antigravity';
import { HookTarget, install, listTargets, nodeAvailable, uninstall } from './hooks/installer';
import { OfficeViewProvider } from './webview/officeProvider';

const RECENT_MS = 6 * 60 * 60 * 1000;

let server: EventServer | undefined;
let guardian: EventServer | undefined;
let web: OfficeWeb | undefined;
const disposers: Array<() => void> = [];
const codexRuns: CodexRun[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = () => vscode.workspace.getConfiguration('agentOffice');

  // ── Nomes (fichas .md dos agentes) ─────────────────────────────────
  const names = new NameDirectory(() => agentDirs());
  names.setOverrides(config().get<Record<string, string>>('names', {}));
  names.load();

  // ── Estado ────────────────────────────────────────────────────────
  const store = new StateStore({
    desks: clamp(config().get<number>('desks', 12), 4, 12),
    idleTimeoutMs: clamp(config().get<number>('idleTimeoutMinutes', 30), 2, 24 * 60) * 60 * 1000,
    resolveName: (a) => names.resolve(a)
  });
  store.host = { appName: vscode.env.appName };
  store.start();
  disposers.push(() => store.dispose());
  const router = new EventRouter(store);
  const delegated = new Set<string>();

  // `waiting` é o único estado acionável — merece notificação nativa.
  store.on('waiting', (agent: Agent) => {
    if (!config().get<boolean>('notifyOnWaiting', true)) return;
    const what = agent.currentAction ? ': ' + agent.currentAction : '';
    void vscode.window.showWarningMessage(`Agent Office — ${agent.displayName} precisa de você${what}`, 'Abrir escritório').then((pick) => {
      if (pick) {
        provider.openPanel();
        provider.post({ type: 'focus', agentId: agent.id });
      }
    });
  });

  // ── Servidor de hooks + descoberta ────────────────────────────────
  const token = await getOrCreateToken(context);
  const preferredPort = config().get<number>('port', 4517);
  const onHook = (payload: unknown, sourceHint: string | undefined, relayed: boolean) => {
    const events = normalizeHook(parseSource(sourceHint), payload);
    if (!events.length) return;
    store.markHooks(events[0].source);
    router.route(events);
    // Hook HTTP do Claude chega só na janela dona da porta: repassa às outras.
    if (!relayed && (sourceHint === 'claude' || sourceHint === undefined)) {
      for (const ep of otherEndpoints()) relayEvent(ep.port, ep.token, sourceHint || 'claude', payload);
    }
  };
  // Extras da UI: personas e os projetos desta janela (filtro "local").
  const extras = () => ({ names: names.personas(), workspace: workspaceProjects() });
  const decorated = (snap = store.snapshot()) => Object.assign({}, snap, extras());

  // Modo navegador: o mesmo escritório em http://127.0.0.1:<porta>/office
  const officeWeb = createOfficeWeb({
    mediaPath: path.join(context.extensionPath, 'media'),
    viewToken: await getOrCreateToken(context, VIEW_TOKEN_KEY),
    port: () => server?.port ?? preferredPort,
    snapshot: () => decorated(),
    onAction: (msg) => {
      if (msg.type === 'clearFinished') store.clearFinished();
    }
  });
  web = officeWeb;
  store.on('change', (snap) => {
    if (officeWeb.clients()) officeWeb.broadcast(decorated(snap));
  });
  const openInBrowser = async () => {
    if (!server) {
      void vscode.window.showErrorMessage('Agent Office: o servidor local não está rodando.');
      return;
    }
    // asExternalUri encaminha a porta em Remote/WSL/SSH; local, não muda nada.
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(officeWeb.url(true)));
    void vscode.env.openExternal(uri);
  };

  try {
    server = await startEventServer(preferredPort, token, onHook, false, officeWeb.handle);
    writeEndpoint(server.port, token, vscode.env.appName);
    store.host.port = server.port;
  } catch (err) {
    void vscode.window.showErrorMessage(`Agent Office: não foi possível subir o servidor local de eventos (${String(err)}).`);
  }
  // Guardião: se outra janela tinha a porta preferida e fechou, assume-a
  // (os hooks HTTP instalados no Claude apontam para ela).
  if (server && server.port !== preferredPort) {
    const timer = setInterval(async () => {
      if (guardian) return;
      try {
        guardian = await startEventServer(preferredPort, token, onHook, true, officeWeb.handle);
      } catch {
        // ainda ocupada por outra janela viva
      }
    }, 20000);
    disposers.push(() => clearInterval(timer));
  }

  // Terminais integrados recebem token/porta (compatível com a v1).
  context.environmentVariableCollection.replace('AGENT_OFFICE_TOKEN', token);
  if (server) context.environmentVariableCollection.replace('AGENT_OFFICE_PORT', String(server.port));

  let hookScript = '';
  try {
    hookScript = installHookScript(context.extensionPath);
  } catch (err) {
    console.error('[agent-office] não consegui copiar o script de hook', err);
  }

  // ── Watchers passivos (zero configuração) ─────────────────────────
  const emit = (events: NormalizedEvent[]) => router.route(events);
  const watchers: Array<{ id: AgentSource; path: () => string; w: { start(): void; stop(): void; status(): { found: boolean; tracked: number; lastSeen: number } } }> = [];
  const sources = config().get<Record<string, boolean>>('sources', {});
  const enabled = (id: string) => sources[id] !== false;
  if (enabled('claude')) watchers.push({ id: 'claude', path: () => path.join(claudeHome(), 'projects'), w: new ClaudeWatcher(emit, { recentMs: RECENT_MS }) });
  if (enabled('codex')) watchers.push({ id: 'codex', path: () => path.join(codexHome(), 'sessions'), w: new CodexWatcher(emit, { recentMs: RECENT_MS, ignore: (id) => delegated.has(id) }) });
  if (enabled('gemini')) watchers.push({ id: 'gemini', path: () => path.join(geminiHome(), 'tmp'), w: new GeminiWatcher(emit, { recentMs: RECENT_MS }) });
  if (enabled('antigravity')) watchers.push({ id: 'antigravity', path: () => antigravityRoots()[0], w: new AntigravityWatcher(emit, { recentMs: RECENT_MS }) });
  for (const { w } of watchers) {
    w.start();
    disposers.push(() => w.stop());
  }
  const refreshSources = () => {
    for (const { id, path: p, w } of watchers) {
      const st = w.status();
      store.setSource({
        id,
        label: SOURCE_LABEL[id],
        status: st.found ? 'watching' : 'missing',
        path: shortPath(p()),
        detail: st.found ? 'lendo ' + shortPath(p()) + (st.tracked ? ' · ' + st.tracked + ' arquivo(s) recentes' : '') : 'pasta não encontrada nesta máquina',
        lastEventAt: st.lastSeen || undefined
      });
    }
  };
  setTimeout(refreshSources, 1500);
  const sourceTimer = setInterval(refreshSources, 10000);
  disposers.push(() => clearInterval(sourceTimer));

  // Fichas de agentes: relê a cada minuto e logo que aparece um projeto
  // novo nos registros (as fichas podem estar no .claude/agents dele).
  const namesSignature = () => JSON.stringify([names.personas(), names.mainName()]);
  const reloadNames = () => {
    const before = namesSignature();
    names.load();
    if (namesSignature() !== before) store.renameAll();
  };
  let cwdCount = 0;
  const namesTimer = setInterval(reloadNames, 60000);
  const cwdTimer = setInterval(() => {
    const n = seenCwds().length;
    if (n === cwdCount) return;
    cwdCount = n;
    reloadNames();
  }, 5000);
  disposers.push(() => clearInterval(namesTimer), () => clearInterval(cwdTimer));

  // ── Webview ───────────────────────────────────────────────────────
  const provider = new OfficeViewProvider(
    context.extensionUri,
    store,
    extras,
    (msg) => {
      if (msg.type === 'clearFinished') store.clearFinished();
      if (msg.type === 'openBrowser') void openInBrowser();
    }
  );
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => store.refresh()));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OfficeViewProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  // ── Barra de status: quem está trabalhando e quem espera você ─────
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'agentOffice.open';
  status.name = 'Agent Office';
  const renderStatus = (snap = store.snapshot()) => {
    const waiting = snap.agents.filter((a) => a.state === 'waiting');
    status.text = '$(organization) ' + snap.agents.length + (waiting.length ? '  $(bell-dot) ' + waiting.length : '');
    status.tooltip = snap.agents.length
      ? snap.agents.map((a) => `${a.displayName} — ${a.currentAction || a.state}`).join('\n')
      : 'Agent Office: nenhum agente trabalhando';
    status.backgroundColor = waiting.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.show();
  };
  store.on('change', (snap) => renderStatus(snap));
  renderStatus();
  context.subscriptions.push(status);

  // ── Comandos ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentOffice.open', () => provider.openPanel()),

    vscode.commands.registerCommand('agentOffice.openBrowser', openInBrowser),

    vscode.commands.registerCommand('agentOffice.copyBrowserLink', async () => {
      if (!server) return;
      await vscode.env.clipboard.writeText(officeWeb.url(true));
      void vscode.window.showInformationMessage('Agent Office: link copiado. Ele dá acesso de leitura ao escritório nesta máquina; o token sai da barra de endereço ao abrir.');
    }),

    vscode.commands.registerCommand('agentOffice.demo', () => {
      provider.openPanel();
      setTimeout(() => provider.post({ type: 'demo', on: true }), 600);
    }),

    vscode.commands.registerCommand('agentOffice.showStatus', () => {
      const lines = [server ? `servidor em 127.0.0.1:${server.port}` : 'servidor parado'];
      for (const { id, w } of watchers) {
        const st = w.status();
        lines.push(`${SOURCE_LABEL[id]}: ${st.found ? 'monitorando (' + st.tracked + ' arquivo(s) recentes)' : 'não encontrado'}`);
      }
      const hooks = listTargets().filter((t) => t.installed).map((t) => t.label);
      lines.push('hooks instalados: ' + (hooks.length ? hooks.join(', ') : 'nenhum (opcional)'));
      void vscode.window.showInformationMessage('Agent Office — ' + lines.join(' · '));
    }),

    vscode.commands.registerCommand('agentOffice.installHooks', async () => {
      if (!server) {
        void vscode.window.showErrorMessage('Agent Office: o servidor local não está rodando.');
        return;
      }
      const targets = listTargets();
      const picks = await vscode.window.showQuickPick(
        targets.map((t) => ({
          label: t.label,
          description: t.installed ? 'instalado' : t.detected ? 'detectado' : 'não detectado',
          detail: t.note + ' — ' + t.file,
          picked: t.detected && !t.installed,
          id: t.id
        })),
        { canPickMany: true, title: 'Agent Office: instalar hooks (opcional, para precisão ao vivo)', placeHolder: 'Escolha as ferramentas' }
      );
      if (!picks || !picks.length) return;
      const needNode = picks.some((p) => p.id !== 'claude');
      if (needNode && !nodeAvailable()) {
        void vscode.window.showWarningMessage('Agent Office: "node" não está no PATH — os hooks de Codex/Gemini/Cursor/Copilot precisam dele. O do Claude Code (HTTP) funciona sem.');
      }
      const ok = await vscode.window.showWarningMessage(
        'O Agent Office vai adicionar hooks (com backup .agent-office.bak) em:\n' + picks.map((p) => targets.find((t) => t.id === p.id)!.file).join('\n'),
        { modal: true },
        'Instalar'
      );
      if (ok !== 'Instalar') return;
      const done: string[] = [];
      const failed: string[] = [];
      for (const p of picks) {
        try {
          install(p.id as HookTarget, { port: preferredPort, token, hookScript });
          done.push(p.label);
        } catch (err) {
          failed.push(p.label + ' (' + String((err as Error).message || err) + ')');
        }
      }
      if (done.length) void vscode.window.showInformationMessage('Agent Office: hooks instalados em ' + done.join(', ') + '. Sessões novas já usam; as abertas podem precisar reiniciar.');
      if (failed.length) void vscode.window.showErrorMessage('Agent Office: falhou em ' + failed.join('; '));
    }),

    vscode.commands.registerCommand('agentOffice.uninstallHooks', async () => {
      const installed = listTargets().filter((t) => t.installed);
      if (!installed.length) {
        void vscode.window.showInformationMessage('Agent Office: nenhum hook instalado.');
        return;
      }
      const picks = await vscode.window.showQuickPick(
        installed.map((t) => ({ label: t.label, detail: t.file, picked: true, id: t.id })),
        { canPickMany: true, title: 'Agent Office: remover hooks' }
      );
      if (!picks) return;
      for (const p of picks) {
        try {
          uninstall(p.id as HookTarget);
        } catch (err) {
          void vscode.window.showErrorMessage('Agent Office: não consegui limpar ' + p.label + ': ' + String(err));
        }
      }
      void vscode.window.showInformationMessage('Agent Office: hooks removidos.');
    }),

    vscode.commands.registerCommand('agentOffice.clearBoard', () => store.clearFinished()),

    vscode.commands.registerCommand('agentOffice.reloadNames', () => {
      names.load();
      store.renameAll();
      const n = Object.keys(names.personas()).length;
      const main = names.mainName();
      const msg = !n
        ? 'nenhuma ficha de agente encontrada em ~/.claude/agents, no .claude/agents dos projetos ou em agentOffice.agentDirs.'
        : `${n} persona(s) carregada(s). ` +
          (main
            ? `Sessão principal: ${main}.`
            : 'Nenhuma ficha se declara claramente a "sessão principal"; para nomear, use "agentOffice.names": { "claude": "Sora" }.');
      void vscode.window.showInformationMessage('Agent Office: ' + msg);
    }),

    vscode.commands.registerCommand('agentOffice.delegateToCodex', async () => {
      const prompt = await vscode.window.showInputBox({ title: 'Delegar ao Codex', prompt: 'O que o Codex deve fazer?' });
      if (!prompt) return;
      const command = config().get<string>('codexCommand', 'codex');
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      codexRuns.push(
        runCodexTask(command, prompt, cwd, emit, {
          onThread: (id) => delegated.add(id),
          onError: (m) => void vscode.window.showErrorMessage('Agent Office: não consegui rodar o Codex (' + m + '). Ajuste agentOffice.codexCommand.')
        })
      );
      provider.openPanel();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentOffice.names')) {
        names.setOverrides(config().get<Record<string, string>>('names', {}));
        store.renameAll();
      }
      if (e.affectsConfiguration('agentOffice.idleTimeoutMinutes')) {
        store.setIdleTimeout(clamp(config().get<number>('idleTimeoutMinutes', 30), 2, 24 * 60) * 60 * 1000);
      }
    })
  );
}

export function deactivate(): void {
  removeEndpoint();
  server?.dispose();
  guardian?.dispose();
  web?.dispose();
  for (const d of disposers.splice(0)) d();
  for (const run of codexRuns) run.dispose();
}

/** Projetos abertos nesta janela, no mesmo formato de `agent.project`. */
function workspaceProjects(): string[] {
  const out = new Set<string>();
  for (const f of vscode.workspace.workspaceFolders || []) {
    const p = projectOf(f.uri.fsPath);
    if (p) out.add(p);
  }
  return [...out];
}

/** Onde procurar fichas de agentes (personas). */
function agentDirs(): string[] {
  const dirs = [path.join(claudeHome(), 'agents'), path.join(os.homedir(), '.codex', 'agents')];
  for (const f of vscode.workspace.workspaceFolders || []) {
    dirs.push(path.join(f.uri.fsPath, '.claude', 'agents'), path.join(f.uri.fsPath, '.agents'));
  }
  const extra = vscode.workspace.getConfiguration('agentOffice').get<string[]>('agentDirs', []);
  for (const d of extra) dirs.push(d.replace(/^~(?=$|[\\/])/, os.homedir()));
  // projetos onde os agentes estão trabalhando (vistos nos registros)
  for (const cwd of seenCwds().slice(0, 80)) {
    const root = projectRootOf(cwd);
    dirs.push(path.join(root, '.claude', 'agents'));
  }
  return [...new Set(dirs)];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number(n) || min)));
}

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

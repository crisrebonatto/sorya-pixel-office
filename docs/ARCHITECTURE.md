# Agent Office
## Documento de Arquitetura — v2 (Dev Hub)

> Extensão para VS Code, Antigravity e Cursor que mostra, em pixel art, cada agente de IA trabalhando na própria mesa de um dev hub, com kanban e feed em tempo real.
>
> **Versão:** 2.0 · **Stack:** TypeScript · VS Code Extension API · Webview + Canvas 2D (pixel art procedural)

---

## 1. Princípio central

O Agent Office **não lê o terminal. Nunca.** Texto de terminal quebra com cor ANSI, quebra de linha, redimensionamento e mudança de formato.

A v1 consumia só hooks do Claude Code, e isso tinha um furo prático: o token e a porta iam como variáveis de ambiente **apenas para os terminais integrados**. Sessões do painel da extensão do Claude Code, do Codex na IDE ou do Gemini nunca chegavam. O escritório ficava vazio (`0/8`) justamente no uso mais comum.

A v2 inverte a prioridade:

1. **Registros locais estruturados (sem configuração).** Toda ferramenta séria já grava a sessão em JSONL/JSON no disco: Claude Code, Codex, Gemini CLI e Antigravity. O escritório lê esses arquivos incrementalmente. Isso funciona em qualquer superfície (terminal, extensão, desktop) sem instalar nada.
2. **Hooks (opcionais).** Trazem o que nenhum registro grava, o instante em que o agente **pede sua aprovação**, e reduzem a latência. Instalação em um comando, com backup e desinstalação limpa.

Você continua trabalhando onde já trabalha. O escritório apenas observa.

---

## 2. Arquitetura

```
 Claude Code ─┐   ~/.claude/projects/**.jsonl, ~/.claude/sessions/*.json
 Codex ───────┤   ~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl
 Gemini CLI ──┤   ~/.gemini/tmp/*/chats/session-*.jsonl
 Antigravity ─┘   ~/.gemini/antigravity*/brain/*/task.md, transcript.jsonl
        │  (tailing incremental, polling ~1 s)
        ▼
 ┌──────────────────────── Extensão (processo Node da IDE) ─────────────────┐
 │ Watchers ─► parsers por fonte ─┐                                          │
 │                                ├─► EventRouter ─► StateStore ─► snapshot  │
 │ HTTP 127.0.0.1 ◄─ hooks ───────┘   (NormalizedEvent)   (memória)    │     │
 │   /hook/<fonte>  (Claude, Codex, Gemini, Cursor, Copilot, Windsurf…)│     │
 │ NameDirectory (fichas .md → personas)                               ▼     │
 │                                                    postMessage (≤ 8/s)    │
 └──────────────────────────────────────────────────────────────┬───────────┘
                                         ┌──────────────────────┴───────────┐
                                         ▼                                  ▼
          Webview: escritório em canvas + kanban      Navegador: GET /office (mesma UI)
                   + feed + detalhe                   estado por SSE em /office/events
```

| Componente | Responsabilidade |
|---|---|
| `watchers/tailer.ts` | Descobre arquivos por varredura periódica e lê só o que foi anexado. Tolera truncamento e reescrita. Na primeira leitura, pega só o fim do arquivo. |
| `watchers/{claude,codex,gemini,antigravity}.ts` | Parser por fonte: linha do registro → `NormalizedEvent[]`, já redigido. |
| `adapters/hooks.ts` | Normalizador universal de hooks: `PreToolUse`, `BeforeTool`, `beforeShellExecution`, `pre_run_command`… viram o mesmo evento. |
| `core/stateStore.ts` | Agentes, mesas fixas, tarefas, feed, deduplicação hook × registro, heurística de espera, limpeza por inatividade. |
| `core/names.ts` | Personas a partir das fichas de agentes; overrides nas configurações. |
| `server/*` | Servidor local (token, `Host` local, repasse entre janelas), descoberta por janela e redação. |
| `core/live.ts`, `server/mask.ts` | Terminal ao vivo (opt-in): os parsers anexam comando/saída/diff brutos ao evento só com ele ligado; o `LiveLog` mascara, corta e guarda algumas dezenas de entradas por agente, em memória. |
| `server/officeWeb.ts` | Modo navegador: serve a mesma UI em `/office`, estado ao vivo por Server-Sent Events, token de visualização que vira cookie. |
| `hooks/installer.ts` | Instala e remove hooks em Claude, Codex, Gemini, Cursor e Copilot. |
| `media/pixel/*` | Engine de pixel art procedural: personagens, mobília, mapa, cena. |

### Por que tudo dentro da extensão

A extensão já é um processo Node completo. Um daemon separado traria ciclo de vida de processo, processo órfão e instalação em dois passos, sem ganho enquanto o escritório só precisa existir com a IDE aberta. O `StateStore` não depende do VS Code: dá para extrair para um daemon quando o "modo companion" (IDE fechada) fizer sentido.

---

## 3. Fontes

Todos os formatos são **internos às ferramentas** e mudam entre versões. Os parsers são defensivos, ignoram o que não reconhecem e são testados com fixtures.

### Claude Code
- **Arquivos.** `~/.claude/projects/<cwd-sanitizado>/<sessão>.jsonl`. Subagentes ficam em `<sessão>/subagents/agent-<id>.jsonl`, com `agent-<id>.meta.json` ao lado (`agentType`, `description`, `toolUseId`). Terminal, extensão da IDE e app desktop gravam no mesmo lugar (`entrypoint` diz qual).
- **Mensagens.** Cada bloco de uma resposta vira uma linha (mesmo `message.id`). Tokens são somados por delta, por mensagem. Linhas repetidas (compactação) são descartadas por `uuid`.
- **Pedidos.** Um `user` com texto é pedido; com `tool_result`, é fim de ferramenta (`is_error` indica falha). `[Request interrupted…` é interrupção. `attachment/queued_command` traz as mensagens enviadas no meio do turno (viram card) e o `<task-notification>` que avisa que um subagente em background terminou.
- **Fim de turno.** Vem de `stop_reason: end_turn` e de `system/turn_duration`. `last-prompt` dá o título do pedido quando a leitura começou no meio do arquivo.
- **Tarefas.** `TodoWrite`, `TaskCreate` e `TaskUpdate` viram tarefas. Nos modelos atuais essas ferramentas vêm desligadas por padrão, por isso o kanban se apoia em pedidos e subagentes.
- **Sessões vivas.** `~/.claude/sessions/<pid>.json` diz quais sessões estão vivas (pid, `status`, `entrypoint`, `cwd`). Processo morto significa que o agente sai, e o histórico dele não ressuscita no replay.

### Codex
- **Arquivos.** `$CODEX_HOME/sessions/AAAA/MM/DD/rollout-*.jsonl`: `{timestamp, type, payload}`, com flush por linha. `session_meta` traz thread, `cwd`, `originator` (`codex-tui`, `codex_vscode`, `codex_exec`…) e subagente (`source.subagent.thread_spawn.parent_thread_id`).
- **Ferramentas.** `function_call`/`custom_tool_call` casam com o output pelo `call_id`. O código de saída vem do texto do output. `apply_patch` fornece a lista de arquivos (`*** Update File:`). `update_plan` vira tarefas.
- **Turnos e tokens.** `task_complete`/`turn_aborted` fecham o turno. `token_count` é acumulado, então o store soma o delta.
- **Aprovação.** Pedidos de aprovação **não** são gravados: só o hook `PermissionRequest` sabe.

### Gemini CLI
- `~/.gemini/tmp/<projeto>/chats/session-*.jsonl` (v0.39+) só anexa. Uma mensagem com o mesmo `id` é reanexada quando muda, e vence a última. Há ainda `{"$set"}`/`{"$rewindTo"}`. O formato antigo é um `.json` reescrito inteiro.
- Ferramentas só entram depois de concluídas. Uma resposta sem ferramentas encerra o turno.
- `.project_root` dá o caminho real do projeto.

### Antigravity *(best effort)*
- `brain/<conversa>/task.md`: checklist `[ ]` / `[/]` / `[x]` vira tarefas do quadro.
- `transcript.jsonl` (builds novos): passos com `tool_calls`.
- Mudança em `conversations/<id>.pb|.db` significa agente ativo. Novos arquivos em `code_tracker/active` são arquivos editados.
- Os três diretórios (`antigravity`, `antigravity-ide`, `antigravity-cli`) são lidos.

---

## 4. Hooks

| Ferramenta | Evento de "espera" | Transporte |
|---|---|---|
| Claude Code | `PermissionRequest`, `Notification(permission_prompt)` | HTTP → `127.0.0.1:4517/hook/claude` com `Bearer` |
| Codex | `PermissionRequest` | `command` async → `~/.agent-office/hook.js codex` |
| Gemini CLI | `Notification(ToolPermission)` | `command` → `hook.js gemini` (imprime `{}`) |
| Cursor | `beforeShellExecution`… | `command` → `hook.js cursor` |
| Copilot (VS Code) | — | `command` → `hook.js copilot` |

- **Descoberta por janela.** Cada janela publica `~/.agent-office/endpoints/<pid>.json` (porta + token, `0600`). O `hook.js` fica num caminho estável, então sobrevive a atualizações da extensão, e repassa o evento para **todas** as janelas, limpando endpoints órfãos.
- **Repasse do hook HTTP do Claude.** Ele chega só na janela dona da porta preferida, que repassa às outras (cabeçalho `X-Agent-Office-Relay` evita laço). Um guardião tenta assumir a porta preferida se a janela dona fechar.
- **Deduplicação.** Hook e registro relatam o mesmo `tool_use_id`, então estatística e feed contam uma vez só.

---

## 5. Modelo de dados

Ver `src/core/types.ts`: `Agent`, `Task`, `Activity`, `OfficeSnapshot`, `NormalizedEvent`.

- **Identidade.** `claude:<sessão>[:<subagente>]`, `codex:<thread>`, `gemini:<sessão>`, `antigravity:<conversa>`, `cursor:<conversa>`… Os ids do hook e do registro coincidem.
- **Mesas fixas.** 12 mesas desenhadas desde o início, preenchidas do centro para fora. `agent_id` novo ocupa a menor mesa livre. Quem sai deixa o nome esmaecido por alguns segundos. Sem mesa livre, o agente fica no lounge.
- **Kanban.** Cada pedido vira um card, fechado no fim do turno (Falhou se interrompido). Cada subagente vira um card com a descrição da delegação. Todos, planos e checklists viram cards explícitos.
- **Reconstrução.** Eventos mais antigos que o timeout de ociosidade não criam agentes. Todo evento carrega os metadados do agente (tipo, título, modelo), para o agente nascer completo mesmo se o início ficou fora da janela lida.
- **Heurística de espera (sem hooks).** Ferramenta que costuma pedir permissão (edição, web, MCP) pendente há mais de 7 s, com o registro em silêncio, vira "aguardando aprovação?". Comandos longos não entram, e com hooks ativos a heurística desliga.

---

## 6. O escritório (webview)

- **Pixel art 100% procedural.** Nada de assets externos. Personagens chibi em vista 3/4 (cabeça grande, 8 estilos de cabelo, 6 tons de pele, contorno automático, 4 direções) com poses de andar, sentar/digitar, mão levantada, acenar, café e sofá. A roupa segue a fonte (Claude terracota, Codex grafite, Gemini azul, Antigravity roxo) e há fones para sessões, boné para `Explore` e óculos para `Plan`.
- **Mapa fixo 34×19.** Open space com 12 mesas (todos de frente para a câmera), server room com LEDs que aceleram com comandos rodando, sala de reunião com TV ao vivo, cozinha, lounge com fliperama e canto do build com painel de CI.
- **Comportamento.**
  - Entra pela porta e anda por BFS na grade até a mesa.
  - Trabalhando: digita, lê.
  - Esperando: levanta a mão e mostra "!".
  - Com erro: olhos em X e plaquinha vermelha.
  - Ocioso há mais de 14 s: café, depois sofá, pufe, fliperama ou pingue-pongue (a bola aparece quando os dois lados estão ocupados).
  - Subagente que concluiu: acena e sai.
- **Plaquinha com o nome em cima da cabeça.** Traz o ícone do estado. As que colidem se empilham, e a de quem espera fica amarela, com um "!" quicando.
- **Renderização.** Buffer nativo 544×304 com escala *sharp-bilinear* (vizinho mais próximo até k inteiro, bilinear até o alvo), então fica nítido em qualquer tamanho e DPI. Os textos são desenhados em alta resolução por cima. A iluminação segue a hora real e a ocupação (escritório vazio fica na penumbra), e o loop roda a 30 fps, pausando com a aba oculta.
- **Layout.** Escritório em cima, kanban embaixo (divisor arrastável). O feed lateral só aparece quando não rouba tamanho do escritório. Em painel estreito a câmera aproxima nas mesas (arrastar move).
- **Acessibilidade.** `prefers-reduced-motion` desliga caminhadas (teletransporta), piscadas e animações, mantendo estado por cor e ícone.
- **Modo navegador.** O mesmo `office.html` é servido em `http://127.0.0.1:<porta>/office`. O `media/browser.js` faz o papel da API da webview: recebe o snapshot por SSE, guarda preferências em `localStorage` e manda ações (limpar o quadro) por `POST /office/action`. O código da UI é um só nos dois lugares.

---

## 7. Segurança

- Servidor com bind **sempre** em `127.0.0.1`. Token por janela, com comparação em tempo constante. Só aceita `Host` local, contra DNS rebinding.
- **Redação** (`server/redact.ts`) antes de qualquer estado: basename de arquivo, binário + subcomando simples, host de URL. Nunca conteúdo de edição, texto de busca ou argumentos.
- Webview com CSP sem `connect-src` e scripts só com nonce.
- Terminal ao vivo (opt-in, desligado por padrão):
  - o conteúdo bruto nunca sai do processo da extensão: `server/mask.ts` troca segredos por `‹oculto›` antes de virar `LiveEntry`;
  - três camadas: arquivos sensíveis sem conteúdo; comandos que leem arquivo ou imprimem segredo sem saída; padrões conhecidos (tokens com prefixo, JWT, chaves privadas, `SENHA=valor`, cabeçalhos, URL com senha, CPF/CNPJ, cartão, e-mail, entropia);
  - testes de vazamento (`test/live.test.js`) com uma lista de segredos que não podem sobrar e de código comum que não pode mudar.
- Modo navegador:
  - Token de **visualização** separado do token dos hooks. `/office?t=<token>` grava um cookie `HttpOnly; SameSite=Strict` e redireciona para `/office`, então o token não fica na barra de endereço, nem em print ou gravação.
  - Sem o cookie, só os arquivos estáticos da UI respondem (código da extensão, sem dados).
  - Ações exigem o cabeçalho `X-Agent-Office`, que força preflight de CORS (nunca respondido): outra origem não dispara ações.
  - CSP com `connect-src 'self'`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`, e a UI só aceita mensagens da própria página.
- Nada persistido além do arquivo de endpoint (`0600`, apagado ao fechar).

---

## 8. Decisões e trade-offs

- **Registros locais antes de hooks.** Zero configuração e cobertura de todas as superfícies. Custo: a espera por aprovação só é exata com hooks.
- **Polling em vez de `fs.watch`.** Comportamento igual em Windows, macOS e Linux, fora do workspace e em discos de rede. Custo: até ~1 s de latência, com poucos `stat` por segundo.
- **Pixel art procedural.** Sem licença de assets, bundle leve, variedade infinita de bonecos. Custo: cada peça é código.
- **Mesas fixas.** Memória espacial ("a mesa do meio é da Sora"). Custo: espaço ocioso com poucos agentes.
- **Sem persistência.** Superfície de vazamento próxima de zero. Custo: o histórico é o que os registros das ferramentas ainda têm.

---

## 9. Próximos passos

- Modo companion (escritório com a IDE fechada), extraindo o `StateStore` para um daemon.
- Histórico e métricas por projeto (custo, tempo por tarefa), com política de retenção.
- Leitura das sessões do Copilot Chat (`workspaceStorage/*/chatSessions/*.jsonl`) e do Copilot CLI.
- Som (desligado por padrão, sempre).

*Agent Office · Documento de arquitetura v2*

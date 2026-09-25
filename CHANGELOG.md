# Changelog

Formato: cada versão tem uma seção `## [x.y.z] — data`. O workflow de
release usa a seção da versão como texto da Release no GitHub.

## [0.4.0] — 2026-09-25

**Terminal ao vivo** (opt-in): no painel de cada agente, a aba **terminal** mostra os comandos que ele roda, a saída (testes, build) e os diffs de código, sem mostrar chaves nem dados sensíveis.

- Liga pelo botão na própria aba ou por `Agent Office: Ligar/desligar terminal ao vivo`, com confirmação. Começa desligado.
- Claude Code (Bash, Edit, MultiEdit, Write) e Codex (shell/exec_command, apply_patch). Leituras (Read, Grep, WebFetch) nunca aparecem.
- Comando com ✓/✕ e código de saída; saída com as últimas 60 linhas; diff colorido com +/−.
- Também no modo navegador e na **demo** (com terminal fictício, bom para gravar).

### Privacidade
- **Mascaramento antes de sair da extensão**: tokens com formato conhecido (Anthropic, OpenAI, GitHub, AWS, Google, Slack, Stripe, Supabase, npm…), JWT, chaves privadas, `SENHA=valor`, `"apiKey": "…"`, `Authorization: …`, URL com senha, CPF/CNPJ, cartão, e-mail e strings longas com cara de aleatórias viram `‹oculto›`. Cada entrada mostra quantos itens foram ocultados.
- **Arquivos sensíveis** (`.env*`, chaves, credenciais, `.ssh/`, `.aws/`, tfvars…) nunca têm conteúdo mostrado. Dá para acrescentar outros em `agentOffice.liveTerminalHide`.
- **Comandos que leem arquivo inteiro ou imprimem segredo** (`cat`, `head`, `rg`, `env`, `printenv`, `gh auth token`, `vercel env`…) mostram só o comando.
- Comando multilinha (heredoc) mostra só a primeira linha. Tudo em memória, algumas dezenas de entradas por agente.
- O mascaramento pega os formatos comuns, mas não é infalível: uma senha que parece texto comum pode passar. Por isso a leitura bruta de arquivos fica de fora.

## [0.3.1] — 2026-09-25

Nome da sessão principal (ex.: **Sora**) mais confiável.

- Quando várias fichas citam a sessão principal ("chamado pela sessão principal"), vence a que se declara principal: diz que é a sessão principal, que não é para ser chamada como subagente ou tem "orquestrador" no nome. Antes, qualquer citação empatava e a plaquinha ficava "Claude".
- As fichas agora também são procuradas no `.claude/agents` de cada projeto em que os agentes estão trabalhando, e não só no projeto aberto na janela.
- `Agent Office: Recarregar nomes dos agentes` diz quantas personas achou e quem é a sessão principal, ou por que não achou.

## [0.3.0] — 2026-09-25

**Modo navegador**: o escritório também abre fora do editor, em `http://127.0.0.1:4517/office`.

- Comando `Agent Office: Abrir no navegador` e botão **↗** no topo do escritório e na barra da view.
- Mesma interface da extensão, ao vivo (Server-Sent Events): kanban, feed, detalhe dos agentes, demo e zoom.
- Bom para tela cheia, segundo monitor, TV ou gravar a tela.
- `Agent Office: Copiar link do navegador` para abrir em outro navegador.
- A página avisa quando o editor fecha e reconecta sozinha quando ele volta.
- Em Remote/WSL/SSH, a porta é encaminhada pelo próprio editor.

### Filtro de projeto
- Filtro **todos · local** no topo:
  - **todos** (padrão) mostra o escritório inteiro, com todos os projetos da máquina;
  - **local** mostra só quem trabalha no projeto aberto na janela, com o kanban e o feed filtrados junto.
- A escolha fica salva por janela.
- Worktrees agora contam como o repositório de origem. Antes, um subagente em `.claude/worktrees/agent-a4a9…` aparecia com esse nome no lugar do projeto.

### Segurança
- Token de visualização próprio, separado do token dos hooks. Ele vira cookie `HttpOnly; SameSite=Strict` e sai da URL, então não aparece em print nem em vídeo.
- Sem cookie, nenhum dado é servido.
- Ações exigem cabeçalho próprio (contra CSRF).
- CSP com nonce, `X-Frame-Options: DENY` e isolamento de janela.

## [0.2.0] — 2026-09-25

**Sorya Dev Hub**: o escritório virou um dev hub vivo em pixel art e passou a monitorar todos os agentes da máquina, sem configurar nada.

### Escritório
- Pixel art procedural em vista 3/4 (sem assets externos):
  - **Personagens chibi** no estilo Gather: cabeça grande, 8 cabelos, 6 tons de pele, contorno, 4 direções.
  - Poses de andar, sentar/digitar, levantar a mão, acenar, café e sofá.
  - Olhos que piscam e expressões por estado.
- **Planta fixa de dev hub**:
  - Open space com 12 mesas.
  - Server room com LEDs que aceleram com comandos rodando.
  - Sala de reunião com TV ao vivo, cozinha, lounge com fliperama e canto do build com painel de CI.
- Agentes **entram pela porta, sentam, trabalham, pedem aprovação levantando a mão com "!"**, vão tomar café quando ociosos e acenam e saem quando terminam.
- **Nome em cima da cabeça** de cada agente, com ícone do que está fazendo. A plaquinha fica amarela quando ele espera você e vermelha no erro.
- Janelas seguem a hora real (dia, pôr do sol, noite com a cidade acesa) e o relógio da parede é de verdade. Escritório vazio fica na penumbra.
- Escala nítida em qualquer tamanho/DPI. Em painel estreito a câmera aproxima nas mesas.

### Layout
- Escritório grande em cima e **kanban horizontal embaixo** (Pendente · Em execução · Feito · Falhou), com divisor arrastável.
- Feed de atividade ao vivo ao lado, quando há espaço.
- Painel de detalhe do agente: projeto, branch, modelo, onde roda, estatísticas, arquivos tocados, tarefas e últimas ações.
- Comando `Abrir escritório em painel`, modo **demo** e item na barra de status que fica amarelo quando alguém espera você.

### Monitoramento
- **Sem configuração**: leitura incremental dos registros locais de:
  - **Claude Code** (terminal, painel da extensão no VS Code/Antigravity/Cursor, app desktop; subagentes e todos);
  - **Codex** (CLI, IDE, `exec`; subagentes, `update_plan`);
  - **Gemini CLI**;
  - **Antigravity** (checklist do `task.md` e atividade das conversas).
- **Hooks opcionais** para precisão ao vivo (pedido de aprovação exato), com comando de instalação/remoção e backup:
  - Claude Code via hook HTTP;
  - Codex, Gemini CLI, Cursor e Copilot via `~/.agent-office/hook.js`, que repassa para todas as janelas abertas.
- **Nomes dos agentes** lidos das fichas `.md` (`Rick — rick-construtor…`), inclusive slugs antigos e a sessão principal (Sora). Dá para sobrescrever em `agentOffice.names`.
- Correção: na v0.1, eventos só chegavam de terminais integrados. O painel ficava em `0/8` com a extensão do Claude Code.

### Segurança
- Servidor só em `127.0.0.1`, token por janela, bloqueio de `Host` não local.
- Redação antes de virar estado: só nome de arquivo, binário + subcomando, host.
- Nada persistido.

## [0.1.0] — 2026-08-07

Primeira versão: servidor local de eventos com token, hooks do Claude Code, adaptador de delegação ao Codex, 8 mesas fixas com sprites placeholder e quadro de tarefas com 4 colunas.

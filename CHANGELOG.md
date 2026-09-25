# Changelog

Formato: cada versão tem uma seção `## [x.y.z] — data`. O workflow de
release usa a seção da versão como texto da Release no GitHub.

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

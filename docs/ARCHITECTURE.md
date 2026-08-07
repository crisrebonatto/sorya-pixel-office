# Agent Office
## Documento de Arquitetura e Implementação

> Extensão para VS Code e Cursor que mostra, em pixel art, cada agente de IA trabalhando na própria mesa, com quadro de tarefas em tempo real.
>
> **Versão:** 1.0
> **Status:** Especificação para implementação
> **Stack:** TypeScript · VS Code Extension API · Webview · Sprites CSS

---

## 1. Princípio central

O Agent Office não lê o terminal. Nunca.

Interpretar texto de terminal é frágil por natureza: quebra quando o formato muda, quebra com cores ANSI, quebra com quebra de linha, quebra quando a janela redimensiona. Qualquer painel construído em cima disso vive quebrado.

O Agent Office consome **eventos estruturados** emitidos pelos próprios agentes. O Claude Code tem um sistema de hooks que dispara JSON em cada momento relevante do ciclo de vida. O Codex CLI emite um stream de eventos em JSON. São essas duas fontes que alimentam o escritório.

A consequência prática disso é importante: como os hooks do Claude Code disparam igual no terminal, na extensão de IDE, no app desktop e na web, **você continua trabalhando onde já trabalha**. O escritório apenas observa.

### A metáfora

Cada agente ativo ocupa uma mesa. O que ele está fazendo agora define a animação dele. As tarefas ficam num quadro na parede. Quando um agente precisa da sua aprovação, ele levanta a mão.

Você bate o olho e entende o estado da operação inteira sem abrir terminal nenhum.

---

## 2. Arquitetura

```
┌─────────────────────────────────────────────────────┐
│  Claude Code (terminal, IDE, desktop ou web)        │
│  Codex CLI (via adaptador)                          │
└────────────────────┬────────────────────────────────┘
                     │  hooks HTTP (async, com token)
                     ▼
┌─────────────────────────────────────────────────────┐
│  Extensão VS Code (processo Node da própria IDE)    │
│                                                     │
│  ┌───────────────┐   ┌──────────────┐              │
│  │ Servidor HTTP │──▶│ Event Router │              │
│  │ 127.0.0.1     │   │ + State      │              │
│  └───────────────┘   └──────┬───────┘              │
│                             │ postMessage           │
│                             ▼                       │
│                    ┌─────────────────┐              │
│                    │    Webview      │              │
│                    │ Escritório +    │              │
│                    │ Quadro (sprites)│              │
│                    └─────────────────┘              │
└─────────────────────────────────────────────────────┘
```

### Por que tudo dentro da extensão

A extensão do VS Code já roda num processo Node completo. Ela pode abrir um servidor HTTP, manter estado em memória e conversar com a webview por `postMessage`, que é o canal nativo.

Subir um daemon separado com SQLite e WebSocket, como seria a solução "clássica", adicionaria: gerenciamento de ciclo de vida de processo, conflito de porta, risco de processo órfão quando a IDE fecha, e instalação em dois passos. Sem ganho nenhum enquanto o escritório só precisa existir com a IDE aberta.

O daemon separado só se justifica quando você quiser o escritório rodando com o VS Code fechado. Isso está previsto na seção 13, e a arquitetura aqui não impede essa evolução: basta extrair o Event Router para um processo próprio e trocar `postMessage` por WebSocket.

### Componentes

| Componente | Responsabilidade |
|---|---|
| **Servidor HTTP** | Recebe POST dos hooks em `127.0.0.1:PORTA`, valida token, entrega ao router |
| **Event Router** | Normaliza eventos de fontes diferentes num formato único |
| **State Store** | Mantém em memória: mesas ocupadas, estado de cada agente, tarefas |
| **Webview Provider** | Renderiza o escritório, recebe atualizações de estado |
| **Codex Adapter** | Traduz o stream do Codex CLI para o formato normalizado |

---

## 3. A ponte de eventos

### Eventos do Claude Code que importam

| Evento do hook | O que acontece na tela |
|---|---|
| `SessionStart` | Escritório acende, luzes ligadas |
| `SubagentStart` | Agente entra e senta numa mesa |
| `PreToolUse` | Animação muda conforme a ferramenta |
| `PostToolUse` | Volta ao estado de trabalho normal |
| `PostToolUseFailure` | Sprite de erro, monitor pisca vermelho |
| `Notification` (`agent_needs_input`) | Agente levanta a mão |
| `PermissionRequest` | Balão de interrogação sobre a mesa |
| `TaskCreated` | Post-it novo aparece no quadro |
| `TaskCompleted` | Post-it move para a coluna Feito |
| `TeammateIdle` | Agente encosta na cadeira, café na mão |
| `SubagentStop` | Agente levanta e sai, mesa libera |
| `Stop` | Turno encerrado |
| `SessionEnd` | Escritório apaga |

### Os campos que resolvem a atribuição de mesa

- **`agent_id`** identifica unicamente aquele subagente. É o número da mesa.
- **`agent_type`** diz qual é o tipo (`Explore`, `Plan`, ou o nome do seu agente customizado). É o skin do sprite.

Sem esses dois campos você não conseguiria diferenciar dois agentes rodando em paralelo. Com eles, a atribuição é determinística.

### Configuração dos hooks

Os hooks vão em `hooks/hooks.json` empacotado como plugin do Claude Code, para que instalar a extensão já configure a captura. Ver o arquivo no repositório para a configuração completa — todos os eventos da tabela acima postam em `http://127.0.0.1:$AGENT_OFFICE_PORT/event` com `Authorization: Bearer $AGENT_OFFICE_TOKEN`.

### `async: true` não é opcional

Sem essa flag, o Claude Code **espera** o servidor responder antes de continuar. Cada tool call passaria a pagar a latência do painel. Com `async`, o hook dispara em background e o trabalho segue.

Essa é a diferença entre um painel que é prazeroso de ter e um painel que você desinstala na segunda semana porque deixou tudo lento.

---

## 4. Modelo de dados

Ver `src/core/types.ts` — os tipos lá são a versão canônica de `AgentSource`, `AgentState`, `Agent`, `Task`, `TaskStatus`, `OfficeState` e `NormalizedEvent`.

### Atribuição de mesa

Escritório com layout **fixo**, não orgânico. Oito mesas desenhadas desde o início, mesa vazia fica vazia.

O motivo é legibilidade: com mesas fixas, seu olho aprende que "a mesa do canto é sempre o Codex". Com mesas nascendo e sumindo, o layout muda a cada evento e você perde a referência espacial, que é justamente o que torna o painel útil de relance.

Regra: `agent_id` novo ocupa a menor mesa livre. Quando o agente sai, a mesa é liberada mas mantém o nome esmaecido por alguns segundos, para você conseguir ler o que acabou de acontecer.

---

## 5. Segurança

Este servidor recebe o `tool_input` completo dos seus agentes: caminhos de arquivo, conteúdo de edições, comandos bash. Tratar isso como dado público seria um erro sério.

- **Bind restrito:** `server.listen(port, '127.0.0.1')` — nunca `0.0.0.0`.
- **Token por sessão:** gerado na ativação, guardado em `SecretStorage`, exportado como variável de ambiente que o hook interpola no header. Sem token: 401.
- **Porta dinâmica com fallback:** tenta `4517`; se ocupada, sobe na próxima livre e exporta a porta real.
- **Redação do payload:** conteúdo de `Edit`/`Write` descartado (só o nome do arquivo); `Bash` guarda só o binário; nada é persistido em disco na v1.
- **CSP da webview:** sem `connect-src` — a webview não fala com a rede, só recebe `postMessage`.

---

## 6. A interface

Container próprio na Activity Bar, ícone de prédio. Em tela estreita o quadro fica abaixo do escritório; em tela larga, lado a lado.

`retainContextWhenHidden: true` impede o escritório de resetar na troca de aba. Custa memória; é memória bem gasta.

### Identidade visual

| Elemento | Valor |
|---|---|
| Fundo do escritório | `#0D0D0C` |
| Piso e paredes | `#161615` e `#1C1C1B` |
| Mesa e mobiliário | `#242423` |
| Acento (agente ativo) | `#C96A47` |
| Sucesso | `#6DB86F` |
| Atenção | `#E0B84A` |
| Erro | `#E06464` |
| Fonte dos rótulos | JetBrains Mono, uppercase, letter-spacing `.09em` |

O agente ativo recebe um brilho terracota sutil na mesa. Os inativos ficam dessaturados.

---

## 7. Estados de animação

Sprites em CSS com `steps()`, não engine de jogo. Sprite sheets de 128×32 (4 frames de 32px), `image-rendering: pixelated`.

| Estado | Vem de | Animação |
|---|---|---|
| `idle` | `TeammateIdle`, sem evento recente | Respiração lenta, xícara na mesa |
| `thinking` | Entre `Stop` e próximo tool | Balão de reticências pulsando |
| `reading` | `PreToolUse`: Read, Grep, Glob | Folheando documento |
| `writing` | `PreToolUse`: Edit, Write | Digitando |
| `running` | `PreToolUse`: Bash | Terminal na tela |
| `searching` | `PreToolUse`: WebFetch, WebSearch | Globo girando |
| `waiting` | `Notification`, `PermissionRequest` | Mão levantada, "!" piscando |
| `error` | `PostToolUseFailure` | Monitor vermelho |
| `done` | `SubagentStop` | Levanta, acena, sai |

`waiting` é o único estado que exige ação sua: o card pulsa em `#E0B84A` e a extensão pode disparar notificação nativa. Com `prefers-reduced-motion`, o estado é comunicado por ícone estático e cor, sem perda de informação.

---

## 8. Quadro de tarefas

As colunas nascem dos eventos, não do Kanban clássico — não existe evento de "revisão", então não existe coluna de revisão.

| Coluna | Origem | Cor |
|---|---|---|
| **Pendente** | `TaskCreated` | Neutro |
| **Em execução** | `SubagentStart` ou primeiro `PreToolUse` da tarefa | Terracota |
| **Feito** | `TaskCompleted` | Verde |
| **Falhou** | `PostToolUseFailure`, `StopFailure` | Vermelho |

A coluna "Falhou" é a que o Kanban tradicional esquece e que num painel de agentes é essencial.

Clicar no card destaca a mesa do agente responsável; clicar na mesa destaca a tarefa.

---

## 9. Adaptador do Codex

```
Claude chama comando de delegação
        ↓
Adaptador registra a tarefa com assignee: codex
        ↓
Adaptador executa o Codex CLI capturando o stream de eventos
        ↓
Traduz cada evento para o formato normalizado
        ↓
Entrega ao mesmo router dos hooks
```

| Evento Codex | Estado no escritório |
|---|---|
| início de thread | `SubagentStart`, senta na mesa |
| início de turno | `thinking` |
| execução de comando | `running` |
| alteração de arquivo | `writing` |
| conclusão | `done`, tarefa vai para Feito |
| erro | `error`, tarefa vai para Falhou |

**Ressalva:** confirme a sintaxe exata do flag de saída JSON na documentação atual do Codex CLI. A tradução vive isolada em `translateCodexEvent()` justamente por isso — se o formato mudar, troca-se uma função, não a arquitetura.

---

## 10. Estrutura de arquivos

`src/` roda no Node da extensão e tem acesso ao sistema. `media/` roda na webview isolada e só recebe mensagens. Nunca misturar os dois. Ver a árvore real do repositório — ela segue a spec.

---

## 11. Fases de implementação

- **Fase 1 — A ponte:** servidor + token + hook + eventos chegando. Se a ponte não funciona, o resto é decoração.
- **Fase 2 — O escritório:** 8 mesas fixas, atribuição por `agent_id`, sprites, skins, painel de detalhe.
- **Fase 3 — O quadro:** 4 colunas reais, cards, ligação bidirecional card↔mesa.
- **Fase 4 — Codex:** comando de delegação, captura e tradução do stream.
- **Fase 5 — Acabamento:** notificação nativa, `prefers-reduced-motion`, configurações, `.vsix`.

---

## 12. Decisões e trade-offs

- **Servidor dentro da extensão:** instalação em um passo, sem processo órfão. Custo: escritório só existe com a IDE aberta. Extração para daemon é mecânica quando precisar.
- **Sprites CSS:** bundle leve, sem atrito com CSP. Custo: teto de complexidade visual — problema bom de se ter.
- **Mesas fixas:** memória espacial e leitura de relance. Custo: espaço ocioso com poucos agentes.
- **Sem persistência na v1:** superfície de vazamento próxima de zero. Custo: fechou a IDE, perdeu o histórico.
- **`retainContextWhenHidden`:** o escritório sobrevive à troca de aba. Custo: memória. Bem gasta.

---

## 13. O que fica para a v2

- **Modo companion:** escritório com a IDE fechada — aí sim o daemon separado.
- **Histórico e métricas:** exige persistência e decisões de privacidade/TTL.
- **Mais adaptadores:** Cursor Agent, Gemini CLI — a camada de normalização já está pronta para isso.
- **Escritório vivo:** agentes que caminham e interagem — onde uma engine gráfica passa a se justificar.
- **Som:** desligado por padrão, sempre.

---

*Agent Office · Documento de arquitetura v1.0*

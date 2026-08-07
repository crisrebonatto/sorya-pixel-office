# Agent Office

Extensão para VS Code e Cursor que mostra, em pixel art, cada agente de IA trabalhando na própria mesa, com quadro de tarefas em tempo real.

O escritório **não lê o terminal, nunca**. Ele consome eventos estruturados: os hooks HTTP do Claude Code e o stream JSON do Codex CLI. Como os hooks disparam igual no terminal, na IDE, no desktop e na web, você continua trabalhando onde já trabalha — o escritório apenas observa.

A especificação completa (arquitetura, decisões e trade-offs) está em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Como funciona

```
Claude Code / Codex CLI
        │ hooks HTTP (async, token)
        ▼
Servidor local 127.0.0.1 → Event Router → State Store
        │ postMessage
        ▼
Webview: escritório (8 mesas fixas) + quadro (Pendente · Em execução · Feito · Falhou)
```

- Cada `agent_id` ocupa a menor mesa livre; `agent_type` define o skin do sprite.
- Nove estados de animação (`idle` … `done`); `waiting` é o único acionável e pulsa em amarelo, com notificação nativa opcional.
- O payload é **redigido** antes de virar estado: só nome de arquivo, só o binário do comando, nunca conteúdo. Nada é persistido em disco.

## Desenvolvimento

```sh
npm install
npm run compile      # TypeScript → out/
npm run sprites      # regenera as sprite sheets placeholder (128×32, 4 frames)
```

Abra a pasta no VS Code e pressione F5 para rodar a extensão em uma janela de desenvolvimento.

## Instalação dos hooks

`hooks/hooks.json` é um plugin do Claude Code. A extensão exporta `AGENT_OFFICE_TOKEN` e `AGENT_OFFICE_PORT` para os terminais integrados; os hooks interpolam esses valores. Sem o token, o servidor responde 401.

## Configuração

| Setting | Default | |
|---|---|---|
| `agentOffice.port` | `4517` | Porta preferida; se ocupada, sobe na próxima livre |
| `agentOffice.desks` | `8` | Número de mesas |
| `agentOffice.notifyOnWaiting` | `true` | Notificação nativa no estado `waiting` |
| `agentOffice.codexCommand` | `codex` | Binário do Codex CLI |

## Segurança

- Bind **sempre** em `127.0.0.1`, nunca `0.0.0.0`.
- Token por sessão em `SecretStorage`, comparado em tempo constante.
- Webview com CSP sem `connect-src` — ela não fala com a rede.
- v1 sem persistência: o estado morre com a sessão.

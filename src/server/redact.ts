import * as path from 'path';

// O escritório precisa saber QUAL ferramenta rodou, não o conteúdo dela.
// Nada além do que sai daqui entra em estado ou histórico.

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['WebFetch', 'WebSearch']);

export type ToolCategory = 'reading' | 'writing' | 'running' | 'searching' | 'thinking';

export function categorizeTool(toolName: string): ToolCategory {
  if (READ_TOOLS.has(toolName)) return 'reading';
  if (WRITE_TOOLS.has(toolName)) return 'writing';
  if (toolName === 'Bash') return 'running';
  if (SEARCH_TOOLS.has(toolName)) return 'searching';
  return 'thinking';
}

/**
 * Produz o rótulo de ação exibido na mesa a partir de um tool call,
 * descartando todo o conteúdo sensível:
 *  - Edit/Write: só o nome do arquivo (basename), nunca o conteúdo
 *  - Bash: só o binário principal, nunca os argumentos
 *  - WebFetch/WebSearch: só o host, nunca a URL/query completa
 */
export function redactAction(toolName: string, toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>;

  if (WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) {
    const p = input['file_path'] ?? input['path'] ?? input['notebook_path'];
    if (typeof p === 'string' && p.length > 0) {
      const verb = WRITE_TOOLS.has(toolName) ? 'editando' : 'lendo';
      return `${verb} ${path.basename(p)}`;
    }
    if (typeof input['pattern'] === 'string') {
      return 'buscando no código';
    }
    return toolName.toLowerCase();
  }

  if (toolName === 'Bash') {
    const cmd = input['command'];
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
      const binary = path.basename(cmd.trim().split(/\s+/)[0]);
      return `rodando ${binary}`;
    }
    return 'rodando comando';
  }

  if (SEARCH_TOOLS.has(toolName)) {
    const url = input['url'];
    if (typeof url === 'string') {
      try {
        return `consultando ${new URL(url).hostname}`;
      } catch {
        // URL malformada: não vaza nada
      }
    }
    return 'pesquisando na web';
  }

  return toolName;
}

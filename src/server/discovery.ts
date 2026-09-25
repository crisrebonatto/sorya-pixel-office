import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Descoberta do servidor local pelos hooks que NÃO rodam no terminal
 * integrado (extensão do Claude Code, Codex IDE, Gemini, Cursor…). Cada
 * janela com o Agent Office aberto publica ~/.agent-office/endpoints/<pid>.json
 * com porta + token (arquivo 0600, pasta 0700). O script de hook repassa o
 * evento para todas as janelas vivas.
 */

export function agentOfficeHome(): string {
  return process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows ignora modos POSIX; a pasta do usuário já é privada.
  }
}

export function endpointFile(pid = process.pid): string {
  return path.join(agentOfficeHome(), 'endpoints', pid + '.json');
}

export function writeEndpoint(port: number, token: string, app?: string): string {
  const dir = path.join(agentOfficeHome(), 'endpoints');
  ensureDir(agentOfficeHome());
  ensureDir(dir);
  const file = endpointFile();
  const body = JSON.stringify({ port, token, pid: process.pid, app, updatedAt: Date.now() });
  fs.writeFileSync(file, body, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // idem
  }
  return file;
}

export function removeEndpoint(): void {
  try {
    fs.unlinkSync(endpointFile());
  } catch {
    // já removido
  }
}

export interface Endpoint {
  port: number;
  token: string;
  pid: number;
}

/** Outras janelas vivas (para repassar eventos de hook HTTP). */
export function otherEndpoints(): Endpoint[] {
  const dir = path.join(agentOfficeHome(), 'endpoints');
  const out: Endpoint[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.json') || f === process.pid + '.json') continue;
    try {
      const ep = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Endpoint;
      if (typeof ep.port === 'number' && typeof ep.token === 'string') out.push(ep);
    } catch {
      // arquivo sendo escrito ou corrompido
    }
  }
  return out;
}

/**
 * Copia o script de hook para um caminho estável (~/.agent-office/hook.js):
 * o caminho da extensão muda a cada atualização; o dos hooks instalados não.
 */
export function installHookScript(extensionPath: string): string {
  const src = path.join(extensionPath, 'bin', 'agent-office-hook.js');
  const dst = path.join(agentOfficeHome(), 'hook.js');
  ensureDir(agentOfficeHome());
  const body = fs.readFileSync(src);
  let same = false;
  try {
    same = fs.readFileSync(dst).equals(body);
  } catch {
    same = false;
  }
  if (!same) fs.writeFileSync(dst, body, { mode: 0o700 });
  return dst;
}

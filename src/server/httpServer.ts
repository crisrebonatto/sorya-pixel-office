import * as http from 'http';
import { isAuthorized } from './auth';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_PORT_ATTEMPTS = 20;

export interface EventServer {
  port: number;
  dispose(): void;
}

/** Repassa um evento de hook HTTP para outra janela (uma vez só). */
export function relayEvent(port: number, token: string, source: string, body: unknown): void {
  const data = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: '/hook/' + source,
    method: 'POST',
    timeout: 800,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Agent-Office-Relay': '1', 'Content-Length': Buffer.byteLength(data) }
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => undefined);
  req.end(data);
}

/**
 * source = trecho da rota /hook/<source> (undefined em /event);
 * relayed = evento repassado por outra janela (não repassar de novo).
 */
export type HookHandler = (payload: unknown, source: string | undefined, relayed: boolean) => void;

/**
 * Servidor local de eventos dos hooks.
 * Bind SEMPRE em 127.0.0.1 — nunca 0.0.0.0. Escutar na rede exporia o
 * contexto de trabalho para qualquer máquina na mesma rede local.
 * Porta preferida com fallback: se ocupada, sobe na próxima livre.
 *
 * Rotas:  POST /hook/<fonte>  (claude, codex, gemini, cursor, copilot…)
 *         POST /event         (compatível com a v1: payload do Claude Code)
 *         GET  /health        (sem dados; só confirma que é o Agent Office)
 */
export async function startEventServer(preferredPort: number, token: string, onEvent: HookHandler, strict = false): Promise<EventServer> {
  const server = http.createServer((req, res) => {
    // Proteção contra DNS rebinding: só aceita Host local.
    const host = (req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"name":"agent-office","ok":true}');
      return;
    }
    const m = /^\/hook\/([a-z-]{2,24})$/.exec(url);
    if (req.method !== 'POST' || (url !== '/event' && !m)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!isAuthorized(req.headers.authorization, token)) {
      res.writeHead(401);
      res.end();
      return;
    }

    let size = 0;
    let aborted = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      // Responde já, com corpo vazio: hook HTTP do Claude Code trata 2xx
      // vazio como "sem decisão" e segue o trabalho sem esperar por nós.
      res.writeHead(204);
      res.end();
      try {
        onEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')), m ? m[1] : undefined, req.headers['x-agent-office-relay'] === '1');
      } catch {
        // Payload inválido é descartado em silêncio — hook não é confiável.
      }
    });
  });

  const port = await listenWithFallback(server, preferredPort, strict ? 0 : MAX_PORT_ATTEMPTS);
  return {
    port,
    dispose: () => server.close()
  };
}

function listenWithFallback(server: http.Server, preferredPort: number, maxAttempts: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt += 1;
          tryPort(port + 1);
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1'); // nunca 0.0.0.0
    };
    tryPort(preferredPort);
  });
}

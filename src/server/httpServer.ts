import * as http from 'http';
import { isAuthorized } from './auth';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_PORT_ATTEMPTS = 20;

export interface EventServer {
  port: number;
  dispose(): void;
}

/**
 * Servidor local de eventos.
 * Bind SEMPRE em 127.0.0.1 — nunca 0.0.0.0. Escutar na rede exporia o
 * contexto de trabalho para qualquer máquina na mesma rede local.
 * Porta preferida com fallback: se ocupada, sobe na próxima livre.
 */
export async function startEventServer(
  preferredPort: number,
  token: string,
  onEvent: (payload: unknown) => void
): Promise<EventServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/event') {
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
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      // Responde imediatamente: o hook é async e ninguém espera por nós,
      // mas não custa devolver rápido.
      res.writeHead(204);
      res.end();
      try {
        onEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        // Payload inválido é descartado em silêncio — hook não é confiável.
      }
    });
  });

  const port = await listenWithFallback(server, preferredPort);
  return {
    port,
    dispose: () => server.close()
  };
}

function listenWithFallback(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
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

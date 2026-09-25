import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

/**
 * Modo navegador: o mesmo escritório da webview servido em
 * http://127.0.0.1:<porta>/office — para tela cheia, segundo monitor ou
 * gravação de tela. Só leitura, só local.
 *
 * Acesso por um token de VISUALIZAÇÃO (diferente do token dos hooks):
 * /office?t=<token> grava um cookie HttpOnly e redireciona para /office,
 * então o token some da barra de endereço (pode aparecer em print/vídeo).
 * Estado ao vivo por Server-Sent Events em /office/events.
 */

export interface OfficeWebOptions {
  mediaPath: string;
  viewToken: string;
  port: () => number;
  snapshot: () => unknown;
  onAction?: (msg: { type?: string }) => void;
}

export interface OfficeWeb {
  /** true se a requisição era do escritório (já respondida). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  broadcast(snapshot: unknown): void;
  url(withToken: boolean): string;
  clients(): number;
  dispose(): void;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

export function createOfficeWeb(opts: OfficeWebOptions): OfficeWeb {
  const streams = new Set<http.ServerResponse>();
  // Cookies não separam por porta: o nome deriva do token, então todas as
  // janelas do mesmo editor (mesmo token) aceitam o mesmo cookie, e VS Code
  // e Antigravity abertos juntos não se atropelam.
  const cookieName = 'ao_view_' + crypto.createHash('sha256').update(opts.viewToken).digest('hex').slice(0, 10);
  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': ping\n\n');
  }, 20000);

  function same(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  function cookieOk(req: http.IncomingMessage): boolean {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName && same(v.join('='), opts.viewToken)) return true;
    }
    return false;
  }

  function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra?: Record<string, string>): void {
    res.writeHead(status, Object.assign({ 'Content-Type': type }, SECURITY_HEADERS, extra || {}));
    res.end(body);
  }

  function page(): { html: string; csp: string } {
    const html = fs.readFileSync(path.join(opts.mediaPath, 'office.html'), 'utf8');
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "connect-src 'self'",
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    const out = html
      .replaceAll('{{csp}}', csp)
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{media}}', '/office/media')
      // ponte do navegador (SSE + ações) antes dos scripts da UI
      .replace('<script nonce="' + nonce + '"', '<script nonce="' + nonce + '" src="/office/media/browser.js"></script>\n  <script nonce="' + nonce + '"');
    return { html: out, csp };
  }

  function denied(res: http.ServerResponse): void {
    send(
      res,
      401,
      'text/html; charset=utf-8',
      '<!doctype html><meta charset="utf-8"><title>Agent Office</title>' +
        '<body style="background:#0d0d0c;color:#e6e2dc;font:14px system-ui;padding:40px">' +
        '<h1 style="font:600 14px monospace;letter-spacing:.1em;color:#e38b66">AGENT OFFICE</h1>' +
        '<p>Abra pelo VS Code/Antigravity: <b>Ctrl+Shift+P → Agent Office: Abrir no navegador</b>.</p></body>'
    );
  }

  function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): void {
    // Arquivos da UI (código da própria extensão, sem dados): livres.
    if (p.startsWith('/office/media/') && req.method === 'GET') {
      const rel = decodeURIComponent(p.slice('/office/media/'.length));
      const file = path.resolve(opts.mediaPath, rel);
      if (!file.startsWith(path.resolve(opts.mediaPath) + path.sep) || !TYPES[path.extname(file)]) {
        send(res, 404, 'text/plain', 'not found');
        return;
      }
      fs.readFile(file, (err, body) => {
        if (err) send(res, 404, 'text/plain', 'not found');
        else send(res, 200, TYPES[path.extname(file)], body, { 'Cache-Control': 'no-cache' });
      });
      return;
    }

    if (p === '/office' && req.method === 'GET') {
      const t = url.searchParams.get('t');
      if (t !== null) {
        if (!same(t, opts.viewToken)) {
          denied(res);
          return;
        }
        // token vira cookie e sai da URL
        res.writeHead(303, Object.assign({}, SECURITY_HEADERS, {
          'Set-Cookie': `${cookieName}=${opts.viewToken}; HttpOnly; SameSite=Strict; Path=/office; Max-Age=2592000`,
          Location: '/office'
        }));
        res.end();
        return;
      }
      if (!cookieOk(req)) {
        denied(res);
        return;
      }
      const { html, csp } = page();
      send(res, 200, 'text/html; charset=utf-8', html, { 'Content-Security-Policy': csp });
      return;
    }

    if (!cookieOk(req)) {
      send(res, 401, 'text/plain', 'unauthorized');
      return;
    }

    if (p === '/office/events' && req.method === 'GET') {
      res.writeHead(200, Object.assign({}, SECURITY_HEADERS, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }));
      res.write('retry: 2000\n\n');
      res.write('event: state\ndata: ' + JSON.stringify(opts.snapshot()) + '\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (p === '/office/action' && req.method === 'POST') {
      // Cabeçalho próprio força preflight CORS (que não respondemos):
      // outra origem não consegue disparar ações (CSRF).
      if (req.headers['x-agent-office'] !== '1') {
        send(res, 403, 'text/plain', 'forbidden');
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8');
        if (body.length > 4096) req.destroy();
      });
      req.on('end', () => {
        send(res, 204, 'text/plain', '');
        try {
          const msg = JSON.parse(body);
          if (opts.onAction && msg && typeof msg === 'object') opts.onAction(msg);
        } catch {
          // ação inválida: ignora
        }
      });
      return;
    }

    send(res, 404, 'text/plain', 'not found');
  }

  return {
    handle(req, res) {
      let url: URL;
      try {
        url = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        return false;
      }
      const p = url.pathname;
      if (p !== '/office' && !p.startsWith('/office/')) return false;
      try {
        route(req, res, url, p);
      } catch {
        if (!res.headersSent) send(res, 500, 'text/plain', 'error');
        else res.end();
      }
      return true;
    },

    broadcast(snapshot) {
      if (!streams.size) return;
      const frame = 'event: state\ndata: ' + JSON.stringify(snapshot) + '\n\n';
      for (const res of streams) res.write(frame);
    },

    url(withToken) {
      return 'http://127.0.0.1:' + opts.port() + '/office' + (withToken ? '?t=' + opts.viewToken : '');
    },

    clients() {
      return streams.size;
    },

    dispose() {
      clearInterval(heartbeat);
      for (const res of streams) res.end();
      streams.clear();
    }
  };
}

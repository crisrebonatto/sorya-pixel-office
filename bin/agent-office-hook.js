#!/usr/bin/env node
// Agent Office — ponte universal de hooks.
//
//   node ~/.agent-office/hook.js <fonte>      (fonte: gemini, cursor, copilot, codex…)
//
// Lê o JSON do hook no stdin e repassa a TODAS as janelas com o Agent Office
// aberto (~/.agent-office/endpoints/*.json: porta + token, arquivo 0600).
// Nunca bloqueia nem decide nada: sai sempre com código 0, em no máximo
// ~1,5 s, mesmo sem nenhuma janela aberta. Sem dependências.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const source = String(process.argv[2] || 'other').replace(/[^a-z-]/g, '').slice(0, 24) || 'other';
const home = process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office');
const dir = path.join(home, 'endpoints');

// Algumas ferramentas exigem JSON no stdout (Gemini CLI: só JSON).
const STDOUT = { gemini: '{}', cursor: '{}' };

let finished = false;
function done() {
  if (finished) return;
  finished = true;
  const out = STDOUT[source];
  if (out) process.stdout.write(out);
  process.exit(0);
}
setTimeout(done, 1500);

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  data += chunk;
  if (data.length > 1024 * 1024) done();
});
process.stdin.on('end', send);
process.stdin.on('error', done);

function send() {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return done();
  }
  if (!files.length || !data.trim()) return done();
  let pending = files.length;
  const settle = () => {
    pending -= 1;
    if (pending <= 0) done();
  };
  for (const f of files) {
    const file = path.join(dir, f);
    let ep;
    try {
      ep = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      settle();
      continue;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: '/hook/' + source,
        method: 'POST',
        timeout: 800,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + ep.token,
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        res.resume();
        res.on('end', settle);
        res.on('error', settle);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (err) => {
      // janela fechada sem limpar: remove o endpoint órfão
      if (err && err.code === 'ECONNREFUSED' && ep.pid && !alive(ep.pid)) {
        try {
          fs.unlinkSync(file);
        } catch (_) {
          /* outra instância já removeu */
        }
      }
      settle();
    });
    req.end(data);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

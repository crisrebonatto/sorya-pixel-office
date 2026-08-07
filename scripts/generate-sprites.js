#!/usr/bin/env node
// Gera as sprite sheets pixel art (128×32: 4 frames de 32px) sem nenhuma
// dependência — PNG escrito na mão com zlib do Node. São placeholders
// funcionais: personagem sentado com bob de 2px entre frames, uma cor de
// "camisa" por skin. Substitua pelos sprites finais mantendo o formato.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 128;
const H = 32;
const FRAME = 32;

const SKINS = {
  'agent-claude.png': [0xc9, 0x6a, 0x47], // terracota
  'agent-codex.png': [0x6d, 0xb8, 0x6f],  // verde
  'agent-explore.png': [0x4a, 0x8f, 0xb8],
  'agent-plan.png': [0xe0, 0xb8, 0x4a]
};

const SKIN_TONE = [0xd9, 0xb3, 0x8c];
const HAIR = [0x2a, 0x26, 0x22];
const CHAIR = [0x24, 0x24, 0x23];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filtro none
    pixels.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
}

function makeSheet(shirt) {
  const px = Buffer.alloc(W * H * 4); // transparente
  const set = (x, y, rgb) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
  };
  const rect = (x, y, w, h, rgb) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) set(x + dx, y + dy, rgb);
  };

  for (let frame = 0; frame < 4; frame++) {
    const ox = frame * FRAME;
    const bob = frame === 1 || frame === 2 ? 1 : 0; // respiração: sobe/desce 1px

    rect(ox + 10, 24, 12, 6, CHAIR);            // assento
    rect(ox + 9, 14, 2, 12, CHAIR);             // encosto
    rect(ox + 12, 16 - bob, 8, 8, shirt);       // tronco
    rect(ox + 13, 9 - bob, 6, 6, SKIN_TONE);    // cabeça
    rect(ox + 13, 8 - bob, 6, 2, HAIR);         // cabelo
    rect(ox + 12, 18 - bob, 2, 4, SKIN_TONE);   // braço esq
    rect(ox + 18, 18 - bob, 2, 4, SKIN_TONE);   // braço dir
    // mãos no teclado alternam com o frame — sugere digitação
    const hands = frame % 2 === 0 ? 23 : 22;
    rect(ox + 13, hands, 2, 1, SKIN_TONE);
    rect(ox + 17, hands === 23 ? 22 : 23, 2, 1, SKIN_TONE);
  }
  return px;
}

const outDir = path.join(__dirname, '..', 'media', 'sprites');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, shirt] of Object.entries(SKINS)) {
  writePng(path.join(outDir, name), makeSheet(shirt));
  console.log('wrote', name);
}

// furniture.png: uma mesa 32×32 simples, mesma técnica.
{
  const px = Buffer.alloc(32 * 32 * 4);
  const set = (x, y, rgb) => {
    const i = (y * 32 + x) * 4;
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
  };
  for (let x = 2; x < 30; x++) for (let y = 18; y < 21; y++) set(x, y, CHAIR);
  for (const lx of [3, 27]) for (let y = 21; y < 30; y++) { set(lx, y, CHAIR); set(lx + 1, y, CHAIR); }
  const fw = Buffer.alloc(32 * (1 + 32 * 4));
  for (let y = 0; y < 32; y++) px.copy(fw, y * (1 + 32 * 4) + 1, y * 32 * 4, (y + 1) * 32 * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(path.join(outDir, 'furniture.png'), Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(fw)),
    chunk('IEND', Buffer.alloc(0))
  ]));
  console.log('wrote furniture.png');
}

// Screenshot helper: node dev/shot.js <page.html?query> <out.png> [width] [height] [waitMs]
// CLOCK_MS=20000 acelera o relógio (timers, rAF, Date) antes da captura.
const path = require('path');
const { chromium } = require(process.env.PW || '/opt/node22/lib/node_modules/playwright');
(async () => {
  const [page, out, w = '1400', h = '900', wait = '600'] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: Number(process.env.DPR || 1) });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message + '\n' + (e.stack || '')));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  if (process.env.CLOCK_MS) await p.clock.install({ time: new Date(process.env.CLOCK_START || '2026-09-25T14:30:00') });
  const [file, query] = page.split('?');
  await p.goto('file://' + path.resolve(file) + (query ? '?' + query : ''));
  if (process.env.CLOCK_MS) await p.clock.runFor(Number(process.env.CLOCK_MS));
  await p.waitForTimeout(Number(wait));
  if (process.env.CLICK) { const [x, y] = process.env.CLICK.split(',').map(Number); await p.mouse.move(x, y); await p.mouse.click(x, y); if (process.env.CLOCK_MS) await p.clock.runFor(500); await p.waitForTimeout(300); }
  if (process.env.HOVER) { const [x, y] = process.env.HOVER.split(',').map(Number); await p.mouse.move(x, y); if (process.env.CLOCK_MS) await p.clock.runFor(200); await p.waitForTimeout(200); }
  const clip = process.env.CLIP ? (([x, y, cw, ch]) => ({ x, y, width: cw, height: ch }))(process.env.CLIP.split(',').map(Number)) : undefined;
  await p.screenshot({ path: out, fullPage: process.env.FULL === '1', clip });
  if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

// Gera dev/preview.html a partir do media/office.html real (mesmo DOM/CSS/JS
// da webview), com placeholders resolvidos e flags de preview.
// Uso: node dev/build-preview.js [--demo] [--hour=21]
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const hourArg = args.find((a) => a.startsWith('--hour='));
const snapArg = args.find((a) => a.startsWith('--snapshot'));
let html = fs.readFileSync(path.join(root, 'media', 'office.html'), 'utf8');
html = html
  .replaceAll('{{csp}}', "default-src 'self' 'unsafe-inline' file:; img-src * data:")
  .replaceAll('{{nonce}}', 'dev')
  .replaceAll('{{media}}', '../media');
const flags = [];
if (demo) flags.push('window.__AO_DEMO = true;');
if (hourArg) flags.push('window.__AO_FORCE_HOUR = ' + Number(hourArg.split('=')[1]) + ';');
html = html.replace('<script nonce="dev"', '<script>' + flags.join('') + '</script>\n  <script nonce="dev"');
if (snapArg) {
  // snapshot real (dev/fixture-office.js) entregue como a extensão entregaria
  const snap = fs.readFileSync(path.join(__dirname, 'snapshot.json'), 'utf8');
  html = html.replace('</body>', '<script>window.postMessage({ type: "state", state: ' + snap + ' }, "*");</script>\n</body>');
}
fs.writeFileSync(path.join(__dirname, 'preview.html'), html);
console.log('dev/preview.html', flags.join(' '));

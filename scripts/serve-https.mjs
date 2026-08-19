import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 12345;
const HOST = '0.0.0.0';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

let cert, key;
try {
  const mod = await import('selfsigned');
  const generate = mod.generate || mod.default?.generate || mod.default;
  if (typeof generate !== 'function') throw new Error('selfsigned generate not found');
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  const opts = {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          { type: 2, value: 'localhost' },
        ],
      },
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ],
  };
  const pems = generate(attrs, opts);
  cert = pems.cert;
  key = pems.private || pems.key;
  if (!cert || !key) throw new Error('cert generation failed');
  console.log('[serve] selfsigned cert generated (with SAN 127.0.0.1/::1/localhost)');
} catch (e) {
  console.warn('[serve] selfsigned failed:', e.message);
  try {
    cert = fs.readFileSync(path.join(root, 'cert.pem'));
    key = fs.readFileSync(path.join(root, 'key.pem'));
    console.log('[serve] using existing cert.pem/key.pem');
  } catch {
    console.error('Missing cert. Run: openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost"');
    process.exit(1);
  }
}

const server = https.createServer({ cert, key }, (req, res) => {
  try {
    let url = (req.url || '/').split('?')[0];
    url = decodeURIComponent(url);
    if (url === '/') url = '/index.html';
    const file = path.normalize(path.join(root, url));
    if (!file.startsWith(root)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found: ' + url);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    res.writeHead(200, headers);
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      console.error('[serve] stream error', err.message);
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[serve] handler error', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('internal error');
  }
});

server.on('error', (err) => console.error('[serve] server error', err));

server.listen(PORT, HOST, () => {
  console.log(`Serving https://127.0.0.1:${PORT}  (also https://localhost:${PORT})`);
  console.log(`Root: ${root}`);
  console.log('若浏览器提示证书风险，请选“高级 → 继续前往 127.0.0.1（不安全）”，Firefox 若仍 NS_ERROR_NET_EMPTY_RESPONSE，请确保访问 https://127.0.0.1 而非 http，并尝试无痕窗口。');
});

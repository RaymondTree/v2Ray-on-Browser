import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 12345;

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
  const selfsigned = await import('selfsigned');
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  const pems = selfsigned.default.generate(attrs, { days: 365, keySize: 2048, algorithm: 'sha256' });
  cert = pems.cert; key = pems.private;
  console.log('[serve] selfsigned cert generated');
} catch {
  // fallback: try openssl generated files
  try { cert = fs.readFileSync(path.join(root,'cert.pem')); key = fs.readFileSync(path.join(root,'key.pem')); }
  catch { console.error('Missing cert. Run: openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj \"/CN=127.0.0.1\"'); process.exit(1); }
}

const server = https.createServer({ cert, key }, (req, res)=>{
  let url = req.url.split('?')[0];
  if(url === '/') url = '/index.html';
  const file = path.join(root, decodeURIComponent(url));
  if(!file.startsWith(root)){ res.writeHead(403); res.end('forbidden'); return; }
  if(!fs.existsSync(file) || fs.statSync(file).isDirectory()){ res.writeHead(404); res.end('not found'); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control':'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', ()=>{
  console.log(`Serving https://127.0.0.1:${PORT}`);
});

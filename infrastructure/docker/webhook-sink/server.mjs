// Local test receiver for TITAN outbound webhooks (development and tests only).
//
//   POST /<anything>          records the request (headers, raw body) and answers 204
//   POST /status/<code>/...   records it and answers <code> (to exercise retries and failures)
//   GET  /requests            the last 200 recorded requests, newest last
//   DELETE /requests          forgets them
//
// It is reachable only on the compose network, keeps everything in memory, and never
// forwards anything. Signatures are verified by the tests, which know the secrets.
import { createServer } from 'node:http';

const MAX = 200;
const MAX_BODY = 256 * 1024;
let received = [];

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(received));
    return;
  }
  if (req.method === 'DELETE' && req.url === '/requests') {
    received = [];
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= MAX_BODY) chunks.push(c);
  });
  req.on('end', () => {
    const status = /^\/status\/(\d{3})(\/|$)/.exec(req.url ?? '');
    const code = status ? Number(status[1]) : 204;
    received.push({
      at: new Date().toISOString(),
      path: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('x-titan-') || k === 'content-type' || k === 'user-agent')),
      body: Buffer.concat(chunks).toString('utf8'),
      answered: code,
    });
    if (received.length > MAX) received = received.slice(-MAX);
    res.writeHead(code).end();
  });
}).listen(8080, '0.0.0.0', () => console.log('webhook-sink listening on 8080'));

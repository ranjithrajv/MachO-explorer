#!/usr/bin/env node
/**
 * serve.mjs — a static server for the auditability demo, with no dependencies.
 *
 *   node demo/serve.mjs            # http://localhost:8788/demo/
 *   node demo/serve.mjs --port 9000
 *
 * The demo is a module page that imports the generated bundle and (for the audit
 * panel) fetches the source files, so it has to be served over HTTP — `file://`
 * blocks module and fetch for the same reason it always does. This serves the
 * repository root, so `/demo/` and `/src/macho.mjs` are both reachable and the
 * "view source" buttons read the real files rather than a copy.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8788;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.macho': 'application/octet-stream',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  // `/` and any directory path serve their index.html, so `/demo/` works as
  // typed rather than 404ing on a directory the reader cannot read as a file.
  let rel = url === '/' ? '/demo/index.html' : url;
  if (rel.endsWith('/')) rel += 'index.html';
  // Resolve inside ROOT only: `..` in a URL must not read the filesystem above it.
  const full = path.resolve(ROOT, '.' + rel);
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' }).end(data);
  });
}).listen(PORT, () => {
  console.log(`demo: serving ${ROOT}`);
  console.log(`      open http://localhost:${PORT}/demo/`);
});

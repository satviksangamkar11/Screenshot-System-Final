// Serves the fixture over HTTP so the web front end can be exercised
// end to end (the server accepts only http/https URLs, not file://).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
http.createServer(async (req, res) => {
  try {
    const name = (req.url || '/').split('?')[0].replace(/^\//, '') || 'contract-search.html';
    const body = await readFile(path.join(dir, path.basename(name)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(5199, () => console.log('fixture on http://localhost:5199'));

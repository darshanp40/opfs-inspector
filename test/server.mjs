// Serves the repository for the tests. /panel.html?harness gets ops.js and a
// direct transport, so the panel runs without the extension.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

export function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = normalize(join(root, url.pathname === '/' ? 'test/blank.html' : url.pathname));
    if (!file.startsWith(root) || file.includes(`${sep}node_modules${sep}`)) {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = await readFile(file);
      if (url.pathname === '/panel.html' && url.searchParams.has('harness')) {
        body = String(body).replace(
          '<script type="module" src="build/panel.js"></script>',
          '<script src="src/ops.js"></script><script src="test/transport.js"></script><script type="module" src="build/panel.js"></script>',
        );
      }
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

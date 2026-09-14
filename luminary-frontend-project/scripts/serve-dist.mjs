import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.cwd(), 'dist');
const host = process.env.HOST || '127.0.0.1';
const preferredPort = Number(process.env.PORT || 5174);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const insideRoot = (filePath) => filePath === root || filePath.startsWith(`${root}${sep}`);

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${server.address()?.port || preferredPort}`);
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  let filePath = resolve(root, requested);

  if (!insideRoot(filePath)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(root, 'index.html');
  }

  const type = contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type });
  createReadStream(filePath).pipe(response);
});

const listen = (port, attemptsRemaining = 5) => {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsRemaining > 0) {
      listen(port + 1, attemptsRemaining - 1);
      return;
    }
    throw error;
  });
  server.listen(port, host, () => {
    server.removeAllListeners('error');
    console.log(`Luminary frontend listening at http://${host}:${port}`);
  });
};

listen(preferredPort);

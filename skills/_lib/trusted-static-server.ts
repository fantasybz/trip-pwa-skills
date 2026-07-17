import { createServer } from 'node:http';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const ROOT_FILES = new Set(['index.html', 'day.html', 'manifest.json', 'sw.js']);
const ROOT_DIRS = new Set(['css', 'js', 'data', 'assets']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const LOCKDOWN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'self'",
].join('; ');

async function pathStat(path: string) {
  try { return await lstat(path); }
  catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function scanServedTree(path: string, label: string): Promise<void> {
  const st = await pathStat(path);
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error(`trusted browser server refuses symlinked content: ${label}`);
  if (st.isFile()) return;
  if (!st.isDirectory()) throw new Error(`trusted browser server refuses non-file content: ${label}`);
  for (const entry of await readdir(path)) {
    await scanServedTree(join(path, entry), `${label}/${entry}`);
  }
}

export async function assertTrustedStaticTree(out: string): Promise<{ root: string; realRoot: string }> {
  const root = resolve(out);
  const rootStat = await pathStat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('trusted browser server requires a real trip directory, not a symlink');
  }
  for (const file of ROOT_FILES) await scanServedTree(join(root, file), `./${file}`);
  for (const dir of ROOT_DIRS) await scanServedTree(join(root, dir), `./${dir}`);
  return { root, realRoot: await realpath(root) };
}

function allowedRequestPath(pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { return null; }
  if (decoded === '/') return '/index.html';
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = decoded.slice(1).split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts.length === 1) return ROOT_FILES.has(parts[0]) ? decoded : null;
  return ROOT_DIRS.has(parts[0]) ? decoded : null;
}

function setSecurityHeaders(response: import('node:http').ServerResponse): void {
  response.setHeader('Content-Security-Policy', LOCKDOWN_CSP);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export interface TrustedStaticServer {
  origin: string;
  directOrigin: string;
  close: () => Promise<void>;
}

export async function startTrustedStaticServer(out: string): Promise<TrustedStaticServer> {
  const { root, realRoot } = await assertTrustedStaticTree(out);
  const server = createServer((request, response) => {
    void (async () => {
      setSecurityHeaders(response);
      // Forward proxies receive absolute-form request targets. The same held
      // listener doubles as a deny proxy for Chromium: only origin-form static
      // requests can ever reach the allowlisted trip files.
      if (/^https?:\/\//i.test(request.url || '')) {
        response.statusCode = 403;
        response.end('Network blocked by trusted launch-check');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.end('Method Not Allowed');
        return;
      }
      const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      const allowed = allowedRequestPath(pathname);
      if (!allowed) {
        response.statusCode = 404;
        response.end('Not Found');
        return;
      }
      const candidate = resolve(root, `.${allowed}`);
      if (candidate !== root && !candidate.startsWith(root + sep)) {
        response.statusCode = 404;
        response.end('Not Found');
        return;
      }
      let canonical: string;
      try { canonical = await realpath(candidate); }
      catch (error: any) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          response.statusCode = 404;
          response.end('Not Found');
          return;
        }
        throw error;
      }
      if (canonical !== realRoot && !canonical.startsWith(realRoot + sep)) {
        response.statusCode = 404;
        response.end('Not Found');
        return;
      }
      const st = await lstat(candidate);
      if (st.isSymbolicLink() || !st.isFile()) {
        response.statusCode = 404;
        response.end('Not Found');
        return;
      }
      const body = await readFile(canonical);
      response.statusCode = 200;
      response.setHeader('Content-Type', CONTENT_TYPES[extname(canonical).toLowerCase()] || 'application/octet-stream');
      response.setHeader('Content-Length', String(body.byteLength));
      response.end(request.method === 'HEAD' ? undefined : body);
    })().catch(() => {
      if (!response.headersSent) setSecurityHeaders(response);
      response.statusCode = 500;
      response.end('Internal Server Error');
    });
  });
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('trusted browser server could not bind a loopback port');
  }
  let closed = false;
  return {
    // Chromium resolves this reserved test hostname to loopback and bypasses the
    // deny proxy only for this exact host. All other hosts/IPs go to the same
    // listener in proxy form and receive 403.
    origin: `http://trip-pwa.test:${address.port}`,
    directOrigin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose, reject) => {
        try {
          server.close((error: any) => {
            if (!error || error?.code === 'ERR_SERVER_NOT_RUNNING') resolveClose();
            else reject(error);
          });
          server.closeAllConnections?.();
        } catch (error: any) {
          if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolveClose();
          else reject(error);
        }
      });
    },
  };
}

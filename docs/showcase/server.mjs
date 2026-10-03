// Showcase server: serves the demo pages in docs/showcase and forwards /api/*
// to the running API, so pages and API share one origin (the refresh cookie
// works exactly as it will behind Nginx). No dependencies; Node 24+.
//
//   pnpm showcase            -> http://localhost:4100
//
// Development only. Never deploy this.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
try {
  process.loadEnvFile(resolve(root, '../../.env'));
} catch {
  // fall back to defaults
}

const PORT = Number(process.env.SHOWCASE_PORT ?? 4100);
const API_URL =
  process.env.SHOWCASE_API_URL ??
  `http://localhost:${process.env.API_PORT ?? 3000}`;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function proxy(req, res) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  const body =
    req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const upstream = await fetch(API_URL + req.url, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
  });
  const out = {};
  upstream.headers.forEach((value, key) => {
    if (key !== 'set-cookie' && key !== 'content-encoding' && key !== 'content-length') {
      out[key] = value;
    }
  });
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(upstream.status, out);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

// /scenarios/<phase>/<name>: multi-step flows that a browser cannot run on its
// own (for example replaying an httpOnly cookie). Each phase folder may export
// them from scenarios.mjs.
async function scenario(req, res, phase, name) {
  const file = resolve(root, phase, 'scenarios.mjs');
  const mod = await import(pathToFileURL(file).href);
  const run = mod.scenarios?.[name];
  if (!run) {
    res.writeHead(404).end('Unknown scenario');
    return;
  }
  const steps = await run({ apiUrl: API_URL, env: process.env });
  res.writeHead(200, { 'content-type': types['.json'] });
  res.end(JSON.stringify(steps));
}

async function serveFile(res, urlPath) {
  const path = normalize(join(root, decodeURIComponent(urlPath)));
  if (!path.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  let file = path;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await proxy(req, res);
    const match = url.pathname.match(/^\/scenarios\/(phase-\d+)\/([\w-]+)$/);
    if (match) return await scenario(req, res, match[1], match[2]);
    if (url.pathname === '/showcase-config.json') {
      res.writeHead(200, { 'content-type': types['.json'] });
      res.end(
        JSON.stringify({
          apiUrl: API_URL,
          seedPassword: process.env.SEED_PASSWORD ?? 'Questa@2026',
        }),
      );
      return;
    }
    return await serveFile(res, url.pathname);
  } catch (error) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Showcase error: ${error instanceof Error ? error.message : error}`);
  }
}).listen(PORT, () => {
  console.log(`Showcase: http://localhost:${PORT}  (API: ${API_URL})`);
});

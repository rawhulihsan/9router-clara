const http = require('node:http');
const https = require('node:https');

function cleanHeaders(headers) {
  const copy = { ...headers };
  const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())];
  for (const name of hop) delete copy[name];
  return copy;
}

function createFront({ upstream, transform, maxBody = 4 * 1024 * 1024, timeout = 120000 }) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('PROMPT_INJECTION_UPSTREAM must be an HTTP(S) origin');
  const transport = target.protocol === 'https:' ? https : http;
  function proxy(req, res, body) {
    const headers = cleanHeaders(req.headers);
    delete headers['x-9r-peer-token'];
    delete headers['x-9r-injection-internal-token'];
    delete headers['x-9r-real-ip'];
    delete headers['x-9r-via-proxy'];
    headers['x-real-ip'] = req.headers['x-9r-real-ip'] || req.socket.remoteAddress;
    headers['x-forwarded-for'] = headers['x-real-ip'];
    if (body !== undefined) {
      headers['content-length'] = String(body.length);
      delete headers['content-encoding'];
    }
    const out = transport.request(target, { method: req.method, path: req.url, headers }, incoming => {
      res.writeHead(incoming.statusCode, cleanHeaders(incoming.headers));
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    out.setTimeout(timeout, () => out.destroy(new Error('Upstream timeout')));
    out.on('error', () => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(502); res.end('Upstream unavailable'); }
    });
    req.once('aborted', () => out.destroy());
    res.once('close', () => { if (!res.writableFinished) out.destroy(); });
    if (body !== undefined) out.end(body);
    else req.pipe(out);
  }
  async function auth(req) {
    const response = await fetch(new URL('/api/auth/status', target), {
      headers: { cookie: req.headers.cookie || '' }, redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    if (response.status !== 200) throw new Error('Auth upstream unavailable');
    const text = await response.text();
    if (text.length > 65536) throw new Error('Invalid auth response');
    return JSON.parse(text);
  }
  return async (req, res, local) => {
    const fail = (status, message) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: message })); } };
    let pathname;
    try { pathname = decodeURIComponent(req.url.split('?')[0]); }
    catch { return fail(400, 'Invalid request path'); }
    try {
    if (pathname === '/api/prompt-injection/resolve' || pathname.startsWith('/api/prompt-injection/resolve/')) {
      res.writeHead(404); res.end(); return;
    }
    if (pathname === '/api/prompt-injection' || pathname.startsWith('/api/prompt-injection/')) {
      if ((await auth(req)).authenticated !== true) return fail(401, 'Unauthorized');
      return local();
    }
    if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
      const status = await auth(req);
      if (status.authenticated !== true && status.requireLogin !== false) { res.writeHead(307, { location: '/login' }); res.end(); return; }
    }
    const inference = req.method === 'POST' && (/\/(?:chat\/completions|messages|responses|completions)$|:(?:streamGenerateContent|generateContent)$/.test(pathname) || /^\/codex(?:\/|$)/.test(pathname));
    if (inference) {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return fail(415, 'Compressed inference body unsupported');
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => req.destroy(), 30000);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBody) { fail(413, 'Request body too large'); return; }
          chunks.push(chunk);
        }
      } finally { clearTimeout(timer); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return fail(400, 'Invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Expected JSON object');
      const transformed = await transform(body, req);
      const encoded = Buffer.from(JSON.stringify(transformed));
      if (encoded.length > maxBody) return fail(413, 'Transformed body too large');
      return proxy(req, res, encoded);
    }
    if (pathname.startsWith('/api/') || /^\/(?:v1|v1beta|v1alpha|codex)(?:\/|$)/.test(pathname) || pathname === '/systemone' || pathname === '/responses') return proxy(req, res);
    return local();
    } catch { return fail(502, 'Front upstream unavailable'); }
  };
}

module.exports = { createFront, cleanHeaders };

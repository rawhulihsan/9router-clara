const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFront } = require('../prompt-injection-front.cjs');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
test('custom-server routes private resolver and disables provider bootstrap in front mode', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const http = require('node:http');
    const data = fs.mkdtempSync(path.join(process.env.TMPDIR, 'front-test-'));
    const blue = http.createServer((req,res) => req.pipe(res));
    blue.listen(0, '127.0.0.1', () => {
      process.env.PROMPT_INJECTION_UPSTREAM = 'http://127.0.0.1:' + blue.address().port;
      process.env.JWT_SECRET = 'test-only'; process.env.DATA_DIR = data;
      require('./custom-server.js');
      if (!global.__appBootstrapped) throw Error('bootstrap not suppressed');
      const green = http.createServer(async (req,res) => {
        if (req.url !== '/api/prompt-injection/resolve') throw Error('inference reached local Next');
        if (req.headers['x-9r-injection-internal-token'] !== process.env.PROMPT_INJECTION_INTERNAL_TOKEN) throw Error('token mismatch');
        let text=''; for await(const chunk of req) text+=chunk;
        res.end(JSON.stringify({body:{...JSON.parse(text).body, injected:true}}));
      });
      green.listen(0,'127.0.0.1', async () => {
        try {
          const response = await fetch('http://127.0.0.1:'+green.address().port+'/v1/responses', {method:'POST',body:'{"model":"x"}'});
          const body=await response.json(); if(!body.injected) throw Error(JSON.stringify(body));
          console.log('integration passed');
        } finally { green.closeAllConnections(); green.close(); blue.closeAllConnections(); blue.close(); fs.rmSync(data,{recursive:true,force:true}); }
      });
    });`;
  const result = await promisify(execFile)(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), timeout: 15000 });
  assert.match(result.stdout, /integration passed/);
  await assert.rejects(promisify(execFile)(process.execPath, ['-e', "require('./custom-server.js')"], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, PROMPT_INJECTION_UPSTREAM: 'http://127.0.0.1:20128', JWT_SECRET: '', DATA_DIR: '' },
  }), /Front mode requires explicit JWT_SECRET/);
});

test('front cancels upstream stream when client disconnects', async t => {
  let closed;
  const cancelled = new Promise(resolve => { closed = resolve; });
  const blue = await listen((req, res) => {
    res.write('data: first\n\n');
    res.once('close', closed);
  });
  const front = createFront({ upstream: blue.url });
  const green = await listen((req, res) => front(req, res, () => res.end('local')));
  t.after(() => { blue.server.closeAllConnections(); blue.server.close(); green.server.closeAllConnections(); green.server.close(); });
  await new Promise(resolve => {
    const request = http.get(green.url + '/api/stream', response => {
      response.once('data', () => { request.destroy(); resolve(); });
    });
  });
  await Promise.race([cancelled, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('upstream not cancelled')), 1000); timer.unref(); })]);
});

test('front authenticates local APIs against blue and transforms inference with bounded bodies', async t => {
  const blue = await listen((req, res) => {
    if (req.url === '/api/auth/status') return res.end(JSON.stringify({ authenticated: req.headers.cookie === 'auth_token=valid' }));
    req.pipe(res);
  });
  const front = createFront({ upstream: blue.url, maxBody: 128, transform: async (body, req) => ({ ...body, injected: req.url }) });
  const green = await listen((req, res) => front(req, res, () => res.end('local')));
  t.after(() => { blue.server.closeAllConnections(); blue.server.close(); green.server.closeAllConnections(); green.server.close(); });
  assert.equal((await fetch(green.url + '/api/prompt-injection')).status, 401);
  assert.equal(await (await fetch(green.url + '/api/prompt-injection', { headers: { cookie: 'auth_token=valid' } })).text(), 'local');
  const result = await fetch(green.url + '/v1/messages?beta=1', { method: 'POST', body: '{"model":"test"}' });
  assert.deepEqual(await result.json(), { model: 'test', injected: '/v1/messages?beta=1' });
  assert.equal((await fetch(green.url + '/v1/messages', { method: 'POST', body: 'x'.repeat(129) })).status, 413);
  assert.equal((await fetch(green.url + '/v1/messages', { method: 'POST', body: '{' })).status, 400);
  assert.deepEqual(await (await fetch(green.url + '/codex/session', { method: 'POST', body: '{"model":"x"}' })).json(), { model: 'x', injected: '/codex/session' });
  assert.equal(await (await fetch(green.url + '/systemone')).text(), '');
});

test('front preserves opaque API path, API key, stream and denies public resolver', async t => {
  const blue = await listen((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write(JSON.stringify({ url: req.url, key: req.headers.authorization }));
    res.end('\ndata: [DONE]\n');
  });
  const front = createFront({ upstream: blue.url, transform: async body => body });
  const green = await listen((req, res) => front(req, res, () => res.end('local')));
  t.after(() => { blue.server.closeAllConnections(); blue.server.close(); green.server.closeAllConnections(); green.server.close(); });
  const response = await fetch(`${green.url}/api/models?x=%2F`, { headers: { authorization: 'Bearer secret' } });
  assert.equal(await response.text(), '{"url":"/api/models?x=%2F","key":"Bearer secret"}\ndata: [DONE]\n');
  assert.equal(await (await fetch(green.url + '/_next/static/x.js')).text(), 'local');
  assert.equal((await fetch(green.url + '/api/prompt-injection/resolve')).status, 404);
  assert.equal((await fetch(green.url + '/api/prompt-injection/%72esolve')).status, 404);
});

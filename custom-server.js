const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);
const frontUpstream = process.env.PROMPT_INJECTION_UPSTREAM;
if (frontUpstream) {
  // Never let a front process run provider refresh/bootstrap or default to blue's DB.
  if (!process.env.JWT_SECRET || !process.env.DATA_DIR || !path.isAbsolute(process.env.DATA_DIR)) {
    throw new Error('Front mode requires explicit JWT_SECRET and isolated absolute DATA_DIR');
  }
  const marker = path.join(process.env.DATA_DIR, '.prompt-injection-front');
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  if (!fs.existsSync(marker) && fs.readdirSync(process.env.DATA_DIR).length) {
    throw new Error('Front DATA_DIR must be empty on first start; never clone provider credentials');
  }
  fs.writeFileSync(marker, 'Front-only data; never copy provider credentials here.\n', { mode: 0o600 });
  global.__appBootstrapped = true;
  process.env.PROMPT_INJECTION_INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');
}

// Per-process secret proving x-9r-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-9r-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  let front;
  let internal;
  if (frontUpstream) {
    // Private listener invokes only compiled resolver, never public dashboard routes.
    internal = origCreate((req, res) => {
      if (req.url !== '/api/prompt-injection/resolve' || req.headers['x-9r-injection-internal-token'] !== process.env.PROMPT_INJECTION_INTERNAL_TOKEN) {
        res.writeHead(404); res.end(); return;
      }
      handler(req, res);
    });
    const ready = new Promise((resolve, reject) => {
      internal.once('error', reject);
      internal.listen(0, '127.0.0.1', () => resolve(internal.address().port));
    });
    front = require('./prompt-injection-front.cjs').createFront({
      upstream: frontUpstream,
      transform: async (body, req) => {
        const port = await ready;
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-injection/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-9r-injection-internal-token': process.env.PROMPT_INJECTION_INTERNAL_TOKEN },
          body: JSON.stringify({ path: req.url, body, headers: { authorization: req.headers.authorization, 'x-api-key': req.headers['x-api-key'], 'x-goog-api-key': req.headers['x-goog-api-key'] } }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('Injection resolver unavailable');
        const result = await response.json();
        if (!result.body || typeof result.body !== 'object') throw new Error('Invalid injection resolver response');
        return result.body;
      },
    });
  }
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    delete req.headers['x-9r-injection-internal-token'];
    return front ? front(req, res, () => handler(req, res)) : handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  if (internal) server.once('close', () => { internal.closeAllConnections(); internal.close(); });
  server.once("listening", () => {
    if (!frontUpstream) startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || (frontUpstream && contentLength > 4 * 1024 * 1024)) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}

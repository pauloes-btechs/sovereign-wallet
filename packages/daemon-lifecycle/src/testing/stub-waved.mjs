/**
 * Stub waved daemon for lifecycle tests — mimics the REAL waved health
 * semantics observed against wavelength v0.2.0 on 2026-10-30:
 *
 *   /livez  → 200 once the daemon is up ("Daemon ready")
 *   /readyz → 503 "unavailable" until the wallet is initialized (InitWallet
 *             / UnlockWallet), 200 afterwards
 *
 * Test controls:
 *   --port=N           health listen port (required)
 *   --ready-after=ms   /readyz flips to 200 after this delay (default: never)
 *   --crash-after=ms   hard-exit(exitCode) after ms, no cleanup
 *   --exit-code=N      exit code used by --crash-after (default 1)
 *   --never-live       /livez stays 503 forever (boot-timeout tests)
 *   --exit-after=0     exit immediately without serving (boot-exit tests)
 *
 * SIGTERM/SIGINT → clean shutdown, exit 0 (what stop() expects).
 */
import http from 'node:http';

const args = new Map(process.argv.slice(2).map((a) => {
  const [key, ...rest] = a.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));

const port = Number(args.get('port'));
if (!Number.isInteger(port) || port <= 0) {
  console.error('stub-waved: --port=N required');
  process.exit(78);
}
const readyAfterMs = args.has('ready-after') ? Number(args.get('ready-after')) : Number.POSITIVE_INFINITY;
const crashAfterMs = args.has('crash-after') ? Number(args.get('crash-after')) : null;
const crashExitCode = Number(args.get('exit-code') ?? '1');
const neverLive = args.has('never-live');
const exitAfterMs = args.has('exit-after') ? Number(args.get('exit-after')) : null;

const server = http.createServer((req, res) => {
  if (req.url === '/livez') {
    if (neverLive) {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (req.url === '/readyz') {
    if (Date.now() - startedAt >= readyAfterMs) {
      res.writeHead(200);
      res.end('ready');
    } else {
      res.writeHead(503);
      res.end('unavailable');
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

const startedAt = Date.now();
server.listen(port, '127.0.0.1', () => {
  console.log(`stub-waved listening on ${port}`);
});

function terminate() {
  server.close(() => process.exit(0));
  // Force-exit if close hangs on keep-alive connections.
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);

if (crashAfterMs != null) {
  setTimeout(() => process.exit(crashExitCode), crashAfterMs);
}
if (exitAfterMs != null) {
  setTimeout(() => process.exit(Number(args.get('exit-code') ?? '0')), exitAfterMs);
}

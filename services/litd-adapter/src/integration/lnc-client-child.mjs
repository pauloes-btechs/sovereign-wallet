/**
 * Child-process host for ONE lnc-web WASM client (issue #44).
 *
 * The lnc-web 0.3.6-alpha client is a Go js/wasm binary. Go's js/wasm port
 * has no asynchronous preemption, so a goroutine that spins without yielding
 * (the mailbox reconnect loop after disconnect, observed in the integration
 * suite) blocks the JavaScript thread that hosts it: no timer, I/O callback
 * or IPC message is processed again. When that thread was the vitest worker
 * itself, every Promise.race/setTimeout bound in the test went dead with it
 * and the suite hung until the CI job limit.
 *
 * Running each client here, in its own Node process, keeps the test
 * runner's event loop free: the parent (lnc-isolated-client.ts) bounds every
 * call with its own timers and SIGKILLs this process when it stops
 * answering. Nothing in this file needs to be trustworthy for the parent to
 * fail fast.
 *
 * Protocol (Node IPC, `serialization: 'advanced'`):
 *   child -> parent  { type: 'ready' }                          once, after import
 *   parent -> child  { id, op: 'connect', wasmUrl, namespace, pairingPhrase, serverHost }
 *   parent -> child  { id, op: 'request', method, request }
 *   parent -> child  { id, op: 'shutdown' }                    disconnect, then exit(0)
 *   child -> parent  { type: 'result', id, ok: true, value } | { type: 'result', id, ok: false, error }
 *
 * Regtest only — the parent passes NODE_TLS_REJECT_UNAUTHORIZED=0 for the
 * harness mailbox's self-signed certificate.
 */
import WebSocket from 'ws';

// lnc-web's wasm transport expects a WHATWG WebSocket; Node needs the polyfill.
globalThis.WebSocket = WebSocket;

// lnc-web ships a webpack CommonJS bundle: under plain Node ESM its exports
// sit on the default (module.exports) object, not as named exports.
const lncWeb = await import('@lightninglabs/lnc-web');
const WasmManager = lncWeb.WasmManager ?? lncWeb.default?.WasmManager;
if (typeof WasmManager !== 'function') {
  throw new Error('@lightninglabs/lnc-web does not export WasmManager');
}

/** @type {InstanceType<typeof WasmManager> | undefined} */
let manager;

function describeError(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function reply(message) {
  if (process.connected) process.send(message);
}

async function handle(msg) {
  switch (msg.op) {
    case 'connect': {
      manager = new WasmManager(msg.namespace, msg.wasmUrl, {
        onLocalKeyCreated: () => {},
        onRemoteKeyReceived: () => {},
      });
      await manager.preload();
      await manager.run();
      await manager.waitTilReady();
      await manager.connect({ pairingPhrase: msg.pairingPhrase, serverHost: msg.serverHost });
      return null;
    }
    case 'request': {
      if (manager === undefined) throw new Error('request before connect');
      return await manager.request(msg.method, msg.request ?? {});
    }
    case 'shutdown': {
      try {
        manager?.disconnect();
      } finally {
        // The wasm mailbox retry loop survives disconnect() — never linger.
        setImmediate(() => process.exit(0));
      }
      return null;
    }
    default:
      throw new Error(`unknown op ${String(msg.op)}`);
  }
}

process.on('message', (msg) => {
  handle(msg).then(
    (value) => reply({ type: 'result', id: msg.id, ok: true, value }),
    (err) => reply({ type: 'result', id: msg.id, ok: false, error: describeError(err) }),
  );
});

// The parent owns our lifetime: if it goes away, so do we.
process.on('disconnect', () => process.exit(0));

reply({ type: 'ready' });

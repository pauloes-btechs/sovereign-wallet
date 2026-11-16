/**
 * Stand-in for lnc-client-child.mjs in the IsolatedLncClient unit tests.
 * Speaks the same IPC protocol; STUB_MODE selects a failure to reproduce:
 *
 *   ok                echo requests back; shutdown exits cleanly
 *   wedge-on-request  a request spins the event loop synchronously forever —
 *                     what the lnc-web Go/wasm runtime did to the vitest
 *                     worker in issue #44 (no timers, no IPC, no exit)
 *   ignore-shutdown   never exits on shutdown (needs SIGKILL)
 *   crash-on-request  dies mid-request
 *   never-ready       never reports ready
 */
const mode = process.env['STUB_MODE'] ?? 'ok';

process.on('message', (msg) => {
  switch (msg.op) {
    case 'connect':
      process.send({ type: 'result', id: msg.id, ok: true, value: null });
      return;
    case 'request':
      if (mode === 'wedge-on-request') {
        for (;;) {
          // Busy loop that never yields, like a non-preemptible goroutine.
        }
      }
      if (mode === 'crash-on-request') process.exit(3);
      if (msg.method === 'fail') {
        process.send({ type: 'result', id: msg.id, ok: false, error: 'permission denied' });
        return;
      }
      process.send({
        type: 'result',
        id: msg.id,
        ok: true,
        value: { method: msg.method, request: msg.request, bytes: new Uint8Array([1, 2, 3]) },
      });
      return;
    case 'shutdown':
      if (mode === 'ignore-shutdown') return;
      setImmediate(() => process.exit(0));
      return;
  }
});

if (mode === 'ignore-shutdown') {
  // Keep the process alive even after the parent's IPC channel closes.
  process.on('disconnect', () => {});
  setInterval(() => {}, 1_000);
}

if (mode !== 'never-ready') process.send({ type: 'ready' });

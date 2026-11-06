import { defineConfig } from 'vitest/config';

// Run test files one at a time. Every file boots real daemons on ephemeral
// ports picked by "bind :0, read the port, close": between that pick and the
// daemon's own bind, a daemon in a parallel file could take the same port
// (CI saw the stub exit with EADDRINUSE on 127.0.0.1:43137). Serial files
// remove that race; the suite takes seconds either way.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});

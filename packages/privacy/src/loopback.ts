/**
 * Loopback-only binding enforcement — the code-level invariant behind the
 * spec's "loopback-only local RPC" requirement.
 *
 * Every sidecar RPC/health listener the wallet launches must bind a loopback
 * address. The enforcement point is the sidecar's argument list: the same
 * args array handed to the sidecar runtime is validated here before spawn,
 * so a misconfiguration fails fast (boot error) instead of silently exposing
 * a node's RPC to the network.
 */

/** A listen argument that did not bind a loopback address (or could not be parsed — fail closed). */
export class LoopbackViolationError extends Error {
  constructor(
    message: string,
    public readonly violations: readonly string[],
  ) {
    super(message);
    this.name = 'LoopbackViolationError';
  }
}

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True when the host is a loopback address (127.0.0.0/8, ::1, or `localhost`). */
export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  // RFC 6761: names under `.localhost` are guaranteed to resolve to loopback
  // (e.g. the Tauri WebView origin `tauri.localhost`).
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '::1' || IPV4_LOOPBACK.test(h)
  );
}

function normalizeHost(host: string): string {
  // Strip IPv6 brackets and any trailing zone index, lowercase for DNS names.
  return host.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
}

/**
 * Parse a `host:port` listener value. IPv6 forms are bracketed (`[::1]:8080`).
 * Returns the host with brackets stripped; port may be absent.
 */
export function parseHostPort(value: string): { host: string; port?: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) throw new Error(`Unparseable listen value: ${value}`);
    const host = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    if (rest === '') return { host };
    if (!rest.startsWith(':')) throw new Error(`Unparseable listen value: ${value}`);
    return { host, port: parsePort(rest.slice(1), value) };
  }
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon === -1) return { host: trimmed };
  // A bare `:port` means all interfaces — a wildcard bind, never allowed.
  const host = trimmed.slice(0, lastColon);
  const port = parsePort(trimmed.slice(lastColon + 1), value);
  if (host === '') return { host: '0.0.0.0', port };
  return { host, port };
}

function parsePort(raw: string, original: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Unparseable listen value: ${original}`);
  }
  return port;
}

export interface ListenArgsOptions {
  /**
   * Flags treated as listeners. Default matches the daemons this wallet
   * launches: waved's `--health.listen` / `--rpc.listenaddr` /
   * `--rpc.gateway.listenaddr` and litd's `--rpclisten` / `--restlisten` /
   * `--listen` (P2P) / `--nolisten` (boolean — no `=`, never matched).
   */
  listenFlagPattern?: RegExp;
  /** Human-readable daemon name for error messages. */
  label: string;
}

export const DEFAULT_LISTEN_FLAG_PATTERN = /\.(listen|listenaddr)$|^rpc?listen$|^restlisten$|^listen$/;

/**
 * Validate a sidecar argument list: every listener flag must bind loopback.
 * Unparseable listen values are violations (fail closed — unknown bind
 * semantics must fail the check, not pass it).
 *
 * Throws {@link LoopbackViolationError} listing every offending argument.
 */
export function validateSidecarListenArgs(
  args: readonly string[],
  options: ListenArgsOptions,
): void {
  const pattern = options.listenFlagPattern ?? DEFAULT_LISTEN_FLAG_PATTERN;
  const violations: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) continue; // boolean flag (e.g. --nolisten)
    const flag = arg.slice(2, eq);
    if (!pattern.test(flag)) continue;
    const value = arg.slice(eq + 1);
    try {
      const { host } = parseHostPort(value);
      if (!isLoopbackHost(host)) {
        violations.push(`${options.label}: ${arg} binds non-loopback host '${host}'`);
      }
    } catch (err) {
      violations.push(
        `${options.label}: ${arg} is not a parseable host:port (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (violations.length > 0) {
    throw new LoopbackViolationError(
      `${options.label}: sidecar listeners must bind loopback only`,
      violations,
    );
  }
}

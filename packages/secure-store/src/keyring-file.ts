/**
 * FileKeyringStore — DEVELOPMENT/CI FALLBACK ONLY. It holds secrets in
 * plaintext files (mode 0600) under a data root; that is NOT platform
 * secure storage. The constructor refuses to be built without an explicit
 * `acknowledgePlaintext` so production code paths cannot pick it silently —
 * the same fail-closed discipline as the egress policy engine.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KeyringStore } from './keyring.js';

export class FileKeyringStore implements KeyringStore {
  readonly kind = 'file-dev-fallback' as const;

  constructor(
    private readonly dataRoot: string,
    options: { acknowledgePlaintext: boolean },
  ) {
    if (!options.acknowledgePlaintext) {
      throw new Error(
        'FileKeyringStore is a plaintext dev fallback. Pass { acknowledgePlaintext: true } only from dev/CI code paths; production must use the platform keyring (TauriKeyringStore).',
      );
    }
  }

  private entryPath(service: string, account: string): string {
    // service/account are hierarchical namespace components; refuse separators
    // so a hostile service name cannot escape the keyring directory.
    for (const component of [service, account]) {
      if (component.includes('/') || component.includes('\\') || component.includes('..')) {
        throw new Error(`Invalid keyring component: ${JSON.stringify(component)}`);
      }
    }
    return path.join(this.dataRoot, 'keyring', service, encodeURIComponent(account));
  }

  async getPassword(service: string, account: string): Promise<string | undefined> {
    const file = this.entryPath(service, account);
    try {
      const envelope = JSON.parse(await readFile(file, 'utf8')) as { password?: string };
      return typeof envelope.password === 'string' ? envelope.password : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const file = this.entryPath(service, account);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ v: 1, password }, null, 2)}\n`, { mode: 0o600 });
    // writeFile's mode only applies at creation; enforce on overwrite too.
    await chmodIfPresent(file);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    await rm(this.entryPath(service, account), { force: true });
  }
}

async function chmodIfPresent(file: string): Promise<void> {
  try {
    if ((await stat(file)).isFile()) {
      const { chmod } = await import('node:fs/promises');
      await chmod(file, 0o600);
    }
  } catch {
    // raced delete — nothing to chmod
  }
}

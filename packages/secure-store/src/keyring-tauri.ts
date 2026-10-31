/**
 * TauriKeyringStore — production desktop keyring. Delegates to Tauri commands
 * implemented in src-tauri with the Rust `keyring` crate (macOS Keychain /
 * Windows Credential Manager / Secret Service). The invoke function is
 * injected so contract tests can pin the command protocol without Tauri.
 */
import type { KeyringStore } from './keyring.js';

/** Minimal structural type of Tauri's `invoke` (from @tauri-apps/api/core). */
export type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface KeyringCommandContract {
  keyring_get_password: { service: string; account: string };
  keyring_set_password: { service: string; account: string; password: string };
  keyring_delete_password: { service: string; account: string };
}

type GetReply = { password: string | null };

export class TauriKeyringStore implements KeyringStore {
  readonly kind = 'platform-keyring' as const;

  constructor(private readonly invoke: TauriInvoke) {}

  async getPassword(service: string, account: string): Promise<string | undefined> {
    const reply = await this.invoke<GetReply>('keyring_get_password', { service, account });
    return reply.password ?? undefined;
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    await this.invoke('keyring_set_password', { service, account, password });
  }

  async deletePassword(service: string, account: string): Promise<void> {
    await this.invoke('keyring_delete_password', { service, account });
  }
}

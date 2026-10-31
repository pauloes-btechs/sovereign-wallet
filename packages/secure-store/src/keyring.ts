/**
 * KeyringStore — the port to platform secure storage (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service). The wallet database
 * encryption key and nothing else lives here: no seeds, no passwords for
 * human entry (those belong to the daemon's wallet layer).
 */
export interface KeyringStore {
  /** Resolves undefined when no password exists for this service/account. */
  getPassword(service: string, account: string): Promise<string | undefined>;
  /** Creates or overwrites the password. */
  setPassword(service: string, account: string, password: string): Promise<void>;
  /** Idempotent: deleting a missing password resolves normally. */
  deletePassword(service: string, account: string): Promise<void>;
}

/** In-memory keyring for tests. */
export class MemoryKeyringStore implements KeyringStore {
  private readonly entries = new Map<string, string>();

  async getPassword(service: string, account: string): Promise<string | undefined> {
    return this.entries.get(`${service}\u0000${account}`);
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    this.entries.set(`${service}\u0000${account}`, password);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    this.entries.delete(`${service}\u0000${account}`);
  }
}

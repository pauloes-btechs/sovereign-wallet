/**
 * node:sqlite backend (dev/CI only). The built-in driver has no encryption
 * support — this backend is honestly labeled plaintext and the factory
 * refuses it without an explicit opt-in. It exists so the storage LOGIC
 * (schema, serialization, intent-store semantics) is CI-testable without a
 * SQLCipher build.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseCapabilities, EncryptedDatabase } from './encrypted-db.js';

export async function openNodeSqliteDatabase(
  profile: string,
  dataRoot: string,
): Promise<EncryptedDatabase> {
  await mkdir(dataRoot, { recursive: true });
  const db = new DatabaseSync(path.join(dataRoot, `${profile}.sqlite3`));
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');

  const capabilities: DatabaseCapabilities = {
    backend: 'node-sqlite-plaintext',
    encryptedAtRest: false,
  };

  const getStmt = db.prepare('SELECT v FROM kv WHERE k = ?');
  const setStmt = db.prepare(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  const deleteStmt = db.prepare('DELETE FROM kv WHERE k = ?');
  // ESCAPE prevents prefix wildcards (%/_) in keys from acting as LIKE patterns.
  const keysStmt = db.prepare(
    "SELECT k FROM kv WHERE k LIKE ? ESCAPE '\\' ORDER BY k",
  );

  function likePrefix(prefix: string): string {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return `${escaped}%`;
  }

  return {
    capabilities,
    async get(key: string): Promise<string | undefined> {
      const row = getStmt.get(key) as { v: string } | undefined;
      return row?.v;
    },
    async set(key: string, value: string): Promise<void> {
      setStmt.run(key, value);
    },
    async delete(key: string): Promise<void> {
      deleteStmt.run(key);
    },
    async keys(prefix: string): Promise<string[]> {
      const rows = keysStmt.all(likePrefix(prefix)) as Array<{ k: string }>;
      return rows.map((r) => r.k);
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

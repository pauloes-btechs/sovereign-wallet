import type { Authorization } from './keys.js';
import type { ProviderId } from './provider.js';

export interface EncryptedBackup {
  readonly providerId: ProviderId;
  readonly createdAt: string;
  /** Versioned envelope identifier of the encryption scheme. */
  readonly scheme: string;
  /** Seed + (Mode A) VTXO/proof state — opaque without the provider's keys. */
  readonly ciphertext: Uint8Array;
}

export interface RestoreReport {
  readonly providerId: ProviderId;
  readonly restoredAt: string;
  readonly warnings: readonly string[];
}

/**
 * Per-provider backup and restore. Mode A restore must complete before VTXO
 * batch expiry; Mode B (aezeed+SCB) restores channel state from SCB.
 *
 * Contract: `restore` MUST refuse a backup whose providerId differs from the
 * service's own — cross-provider restore is refused explicitly, never
 * partially applied.
 */
export interface BackupRecoveryService {
  readonly providerId: ProviderId;
  createBackup(auth: Authorization): Promise<EncryptedBackup>;
  restore(backup: EncryptedBackup, auth: Authorization): Promise<RestoreReport>;
}

import { describe, expect, it } from 'vitest';
import { PROVIDER_DECLARATIONS } from './capabilities.js';
import { CrossProviderRestoreError, assertSeedCompatible } from './seed.js';
import type { Authorization, KeyManager, SeedMaterial, SeedMaterialHandle } from './keys.js';
import type { BackupRecoveryService, EncryptedBackup, RestoreReport } from './backup.js';
import type { ProviderId } from './provider.js';

// Compile-time contract checks — the interfaces are the deliverable here.
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type _KeyManagerIsProviderNamespaced = Expect<Equal<KeyManager['providerId'], ProviderId>>;
type _BackupServiceIsProviderNamespaced = Expect<
  Equal<BackupRecoveryService['providerId'], ProviderId>
>;

const AUTH: Authorization = { method: 'password', proof: 'test' };
const T0 = '2026-10-30T00:00:00Z';

function declarationFor(providerId: ProviderId) {
  const decl = PROVIDER_DECLARATIONS.find((d) => d.id === providerId);
  if (decl === undefined) throw new Error(`no provider declaration for '${providerId}'`);
  return decl;
}

/** Minimal fakes proving the interfaces are implementable and pinning shape. */
class FakeKeyManager implements KeyManager {
  readonly providerId: ProviderId;
  private next = 0;
  private readonly seeds = new Map<string, SeedMaterial>();

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  async generateSeed(): Promise<SeedMaterialHandle> {
    const id = `handle-${++this.next}`;
    this.seeds.set(id, {
      providerId: this.providerId,
      seedType: declarationFor(this.providerId).capabilities.recoveryModel,
      words: ['fake', 'seed'],
    });
    return { id, providerId: this.providerId, createdAt: T0 };
  }

  async exportSeed(handleId: string, _auth: Authorization): Promise<SeedMaterial> {
    const seed = this.seeds.get(handleId);
    if (seed === undefined) throw new Error(`no seed handle '${handleId}'`);
    return seed;
  }

  async importSeed(seed: SeedMaterial, _auth: Authorization): Promise<SeedMaterialHandle> {
    // Contract under test: import routes through the cross-provider guard.
    assertSeedCompatible(declarationFor(this.providerId), seed.seedType);
    const id = `handle-${++this.next}`;
    this.seeds.set(id, seed);
    return { id, providerId: this.providerId, createdAt: T0 };
  }

  async wipe(handleId: string, _auth: Authorization): Promise<void> {
    this.seeds.delete(handleId);
  }
}

class FakeBackupRecoveryService implements BackupRecoveryService {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  async createBackup(_auth: Authorization): Promise<EncryptedBackup> {
    return {
      providerId: this.providerId,
      createdAt: T0,
      scheme: 'test-aead-v1',
      ciphertext: new Uint8Array([9]),
    };
  }

  async restore(backup: EncryptedBackup, _auth: Authorization): Promise<RestoreReport> {
    if (backup.providerId !== this.providerId) {
      throw new CrossProviderRestoreError(this.providerId, backup.providerId, [this.providerId]);
    }
    return { providerId: this.providerId, restoredAt: T0, warnings: [] };
  }
}

describe('KeyManager contract', () => {
  it('a key manager generates and exports seeds for its own provider only', async () => {
    const km: KeyManager = new FakeKeyManager('wavelength');
    const handle: SeedMaterialHandle = await km.generateSeed();
    expect(handle.providerId).toBe('wavelength');
    const seed = await km.exportSeed(handle.id, AUTH);
    expect(seed.providerId).toBe('wavelength');
    await km.wipe(handle.id, AUTH);
    await expect(km.exportSeed(handle.id, AUTH)).rejects.toThrowError(/no seed handle/);
  });

  it('import routes through the cross-provider guard — a litd seed is refused under Wavelength', async () => {
    const km: KeyManager = new FakeKeyManager('wavelength');
    const foreign: SeedMaterial = {
      providerId: 'wavelength',
      seedType: 'aezeed+scb',
      words: ['abandon', 'abandon'],
    };
    await expect(km.importSeed(foreign, AUTH)).rejects.toThrowError(CrossProviderRestoreError);
  });

  it('import accepts a provider-native seed type', async () => {
    const km: KeyManager = new FakeKeyManager('wavelength');
    const own: SeedMaterial = {
      providerId: 'wavelength',
      seedType: 'mnemonic-ark',
      words: ['abandon', 'abandon'],
    };
    await expect(km.importSeed(own, AUTH)).resolves.toMatchObject({ providerId: 'wavelength' });
  });
});

describe('BackupRecoveryService contract', () => {
  it('restores its own provider’s backups', async () => {
    const svc = new FakeBackupRecoveryService('litd-local');
    const backup: EncryptedBackup = {
      providerId: 'litd-local',
      createdAt: T0,
      scheme: 'test-aead-v1',
      ciphertext: new Uint8Array([1, 2, 3]),
    };
    await expect(svc.restore(backup, AUTH)).resolves.toMatchObject({ providerId: 'litd-local' });
  });

  it('refuses another provider’s backup explicitly', async () => {
    const svc = new FakeBackupRecoveryService('litd-local');
    const foreign: EncryptedBackup = {
      providerId: 'wavelength',
      createdAt: T0,
      scheme: 'test-aead-v1',
      ciphertext: new Uint8Array([1, 2, 3]),
    };
    await expect(svc.restore(foreign, AUTH)).rejects.toThrowError(CrossProviderRestoreError);
  });

  it('every builtin provider declaration is usable by the guard', () => {
    for (const decl of PROVIDER_DECLARATIONS) {
      expect(() => assertSeedCompatible(decl, decl.seedCompatibility[0] ?? '')).not.toThrow();
    }
  });
});

import { describe, expect, it } from 'vitest';

import { LND_PERMISSIONS, MACAROON_PROFILES, permissionListForProfiles } from './macaroons.js';

describe('macaroon profiles', () => {
  it('readonly grants reads only — no write permission anywhere', () => {
    const readonly_ = MACAROON_PROFILES.readonly;
    expect(readonly_.every((p) => p.action === 'read')).toBe(true);
    expect(readonly_.some((p) => p.entity === 'info')).toBe(true);
  });

  it('invoices profile is exactly invoices read+write', () => {
    expect(MACAROON_PROFILES.invoices).toEqual([
      LND_PERMISSIONS.invoicesRead,
      LND_PERMISSIONS.invoicesWrite,
    ]);
  });

  it('payments profile allows offchain (Lightning) writes but not onchain', () => {
    const payments = MACAROON_PROFILES.payments;
    expect(payments).toContainEqual(LND_PERMISSIONS.offchainWrite);
    expect(payments.some((p) => p.entity === 'onchain')).toBe(false);
    expect(payments.some((p) => p.entity === 'invoices')).toBe(false);
  });

  it('admin profile excludes macaroon generation (no self-escalation)', () => {
    const admin = MACAROON_PROFILES.admin;
    expect(admin).not.toContainEqual(LND_PERMISSIONS.macaroonGenerate);
    expect(admin).toContainEqual(LND_PERMISSIONS.onchainWrite);
    expect(admin).toContainEqual(LND_PERMISSIONS.offchainWrite);
  });
});

describe('permissionListForProfiles', () => {
  it('deduplicates overlapping profiles', () => {
    const out = permissionListForProfiles(['payments', 'readonly']);
    const keys = out.map((p) => `${p.entity}:${p.action}`);
    expect(new Set(keys).size).toBe(keys.length);
    // offchain:read appears in both — exactly once.
    expect(keys.filter((k) => k === 'offchain:read').length).toBe(1);
  });

  it('unions invoices+payments for a send/receive UI session', () => {
    const out = permissionListForProfiles(['invoices', 'payments']);
    const keys = new Set(out.map((p) => `${p.entity}:${p.action}`));
    expect(keys.has('invoices:write')).toBe(true);
    expect(keys.has('invoices:read')).toBe(true);
    expect(keys.has('offchain:write')).toBe(true);
    expect(keys.has('onchain:write')).toBe(false);
  });

  it('is deterministic in canonical order (first-seen)', () => {
    const a = permissionListForProfiles(['payments', 'invoices']);
    const b = permissionListForProfiles(['invoices', 'payments']);
    const keys = (list: { entity: string; action: string }[]) =>
      list.map((p) => `${p.entity}:${p.action}`).sort();
    // Same SET, order follows first-seen profile order.
    expect(keys(a)).toEqual(keys(b));
    expect(`${a[0]!.entity}:${a[0]!.action}`).toBe('offchain:read');
  });

  it('rejects unknown profiles loudly', () => {
    expect(() => permissionListForProfiles(['root' as never])).toThrow(/Unknown macaroon profile/);
  });
});

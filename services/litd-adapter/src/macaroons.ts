/**
 * Least-privilege macaroon profiles.
 *
 * The launcher always authenticates the wallet UI with baked, feature-scoped
 * macaroons — the admin macaroon stays in the data dir for recovery/maintenance
 * only. Permission (entity, action) pairs follow lnd's canonical macaroon
 * bakery list (LND v0.21.5-beta.rc1, the version bundled in litd v0.17.8).
 */

export interface MacaroonPermissionSpec {
  readonly entity: string;
  readonly action: string;
}

/** Canonical (entity, action) permissions from lnd's macaroon bakery. */
export const LND_PERMISSIONS = {
  infoRead: { entity: 'info', action: 'read' },
  onchainRead: { entity: 'onchain', action: 'read' },
  onchainWrite: { entity: 'onchain', action: 'write' },
  offchainRead: { entity: 'offchain', action: 'read' },
  offchainWrite: { entity: 'offchain', action: 'write' },
  invoicesRead: { entity: 'invoices', action: 'read' },
  invoicesWrite: { entity: 'invoices', action: 'write' },
  macaroonGenerate: { entity: 'macaroon', action: 'generate' },
  peersRead: { entity: 'peers', action: 'read' },
  peersWrite: { entity: 'peers', action: 'write' },
  messagesRead: { entity: 'messages', action: 'read' },
  messagesWrite: { entity: 'messages', action: 'write' },
} as const satisfies Record<string, MacaroonPermissionSpec>;

/**
 * Feature-scoped profiles the UI may request. Each is minimal on purpose —
 * a profile grants one user-facing capability, never "everything except".
 */
export type MacaroonProfile =
  | 'readonly'
  | 'invoices'
  | 'payments'
  | 'onchain'
  | 'peers'
  | 'admin';

export const MACAROON_PROFILES: Readonly<Record<MacaroonProfile, readonly MacaroonPermissionSpec[]>> = {
  readonly: [LND_PERMISSIONS.infoRead, LND_PERMISSIONS.onchainRead, LND_PERMISSIONS.offchainRead, LND_PERMISSIONS.invoicesRead],
  invoices: [LND_PERMISSIONS.invoicesRead, LND_PERMISSIONS.invoicesWrite],
  payments: [LND_PERMISSIONS.offchainRead, LND_PERMISSIONS.offchainWrite, LND_PERMISSIONS.infoRead],
  onchain: [LND_PERMISSIONS.onchainRead, LND_PERMISSIONS.onchainWrite],
  peers: [LND_PERMISSIONS.peersRead, LND_PERMISSIONS.peersWrite],
  // 'admin' is the escape hatch for recovery/maintenance flows — never the
  // default UI profile. It is the full catalog (minus macaroon generation,
  // so a compromised UI session cannot mint itself more power).
  admin: Object.values(LND_PERMISSIONS).filter((p) => p !== LND_PERMISSIONS.macaroonGenerate),
};

/**
 * Union of the given profiles, deduplicated in canonical order (deterministic
 * for golden tests and stable RPC error messages).
 */
export function permissionListForProfiles(profiles: readonly MacaroonProfile[]): MacaroonPermissionSpec[] {
  const seen = new Set<string>();
  const out: MacaroonPermissionSpec[] = [];
  for (const profile of profiles) {
    const perms = MACAROON_PROFILES[profile];
    if (!perms) {
      throw new Error(`Unknown macaroon profile: ${profile}`);
    }
    for (const perm of perms) {
      const key = `${perm.entity}:${perm.action}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(perm);
      }
    }
  }
  return out;
}

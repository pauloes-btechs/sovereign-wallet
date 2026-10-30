import type { ProviderId, WalletCapabilities } from './provider.js';

/**
 * The static, versioned subset of a provider that the UI and domain services
 * read before anything is started. Capabilities are DECLARED here — never
 * inferred from what another backend can do.
 */
export interface ProviderDeclaration {
  readonly id: ProviderId;
  readonly capabilities: Readonly<WalletCapabilities>;
  /** Seed types this provider accepts. Pairwise disjoint across providers. */
  readonly seedCompatibility: readonly string[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
  }
  return value;
}

/**
 * Mode A — Wavelength. Lightning works via atomic swaps with a swap server
 * (never channels); balances are Ark VTXOs with an expiry clock; escaping a
 * dead operator is a fee-funded unilateral exit (async, hours-to-days).
 */
export const WAVELENGTH_DECLARATION: Readonly<ProviderDeclaration> = deepFreeze({
  id: 'wavelength',
  capabilities: {
    lightningSend: true,
    lightningReceive: true,
    lightningMechanism: 'swaps',
    onchainSend: true,
    onchainReceive: true,
    assets: 'none',
    unilateralExit: 'async',
    recoveryModel: 'mnemonic-ark',
    operatorDependencies: [
      {
        kind: 'swap-server',
        requiredFor: ['send', 'receive'],
        disclosure:
          'Lightning payments are sent and received through an external swap service. Its fee is shown before you confirm a payment.',
      },
      {
        kind: 'ark-operator',
        requiredFor: ['send', 'receive', 'exit', 'recovery'],
        disclosure:
          'Spendable funds are held as Ark VTXOs with an Ark operator. Sending, receiving, and rolling funds forward need the operator to be reachable; if it is not, a unilateral exit moves funds on-chain more slowly and at your cost. Restoring from seed must complete before VTXO batch expiry.',
      },
    ],
  },
  seedCompatibility: ['mnemonic-ark'],
});

/**
 * Mode B — self-operated litd sidecar (desktop). Channel-based Lightning,
 * layer-1 Taproot assets (asset channels stay behind the experimental flag),
 * instant unilateral exit, aezeed + SCB recovery. Self-hosted: no operator
 * dependencies in the base declaration; Pool/Loop are optional liquidity
 * services behind feature detection, not operator dependencies.
 */
export const LITD_LOCAL_DECLARATION: Readonly<ProviderDeclaration> = deepFreeze({
  id: 'litd-local',
  capabilities: {
    lightningSend: true,
    lightningReceive: true,
    lightningMechanism: 'channels',
    onchainSend: true,
    onchainReceive: true,
    assets: 'layer1',
    unilateralExit: 'instant',
    recoveryModel: 'aezeed+scb',
    operatorDependencies: [],
  },
  seedCompatibility: ['aezeed+scb'],
});

/**
 * Mode B — the user's own remote litd over LNC (mobile). Channel-based
 * Lightning through their node; no local seed (the node holds custody of
 * nothing on this device — sessions are macaroon-scoped and revocable).
 */
export const LNC_REMOTE_DECLARATION: Readonly<ProviderDeclaration> = deepFreeze({
  id: 'lnc-remote',
  capabilities: {
    lightningSend: true,
    lightningReceive: true,
    lightningMechanism: 'channels',
    onchainSend: true,
    onchainReceive: true,
    assets: 'none',
    unilateralExit: 'instant',
    recoveryModel: 'remote-macaroon',
    operatorDependencies: [],
  },
  seedCompatibility: ['remote-macaroon'],
});

export const PROVIDER_DECLARATIONS: readonly Readonly<ProviderDeclaration>[] = deepFreeze([
  WAVELENGTH_DECLARATION,
  LITD_LOCAL_DECLARATION,
  LNC_REMOTE_DECLARATION,
]);

/**
 * Structural invariants every declaration must satisfy. Returns a list of
 * violations (empty = valid) so tests and startup checks can assert it.
 */
export function validateDeclaration(decl: Readonly<ProviderDeclaration>): string[] {
  const violations: string[] = [];
  if (decl.seedCompatibility.length === 0) {
    violations.push('seedCompatibility must not be empty');
  }
  if (!decl.seedCompatibility.includes(decl.capabilities.recoveryModel)) {
    violations.push(
      `seedCompatibility must include the recovery model '${decl.capabilities.recoveryModel}'`,
    );
  }
  const hasSwapServer = decl.capabilities.operatorDependencies.some((d) => d.kind === 'swap-server');
  if (decl.capabilities.lightningMechanism === 'swaps' && !hasSwapServer) {
    violations.push("mechanism 'swaps' requires a declared swap-server dependency");
  }
  if (decl.capabilities.lightningMechanism === 'channels' && hasSwapServer) {
    violations.push("mechanism 'channels' must not declare a swap-server dependency");
  }
  for (const dep of decl.capabilities.operatorDependencies) {
    if (dep.requiredFor.length === 0) {
      violations.push(`operator dependency '${dep.kind}' must list requiredFor operations`);
    }
    if (dep.disclosure.trim().length === 0) {
      violations.push(`operator dependency '${dep.kind}' must carry a disclosure`);
    }
  }
  return violations;
}

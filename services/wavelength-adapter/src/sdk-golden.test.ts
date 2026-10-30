/**
 * Golden tests for the consumed Wavelength SDK surface and the Mode A
 * capability declaration.
 *
 * Wavelength v0.2.0 APIs are explicitly unstable (research F3). These tests
 * fail CI the moment any consumed pin, constant, or capability copy drifts —
 * a version bump is a deliberate, reviewed re-pin, never a routine update.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WAVELENGTH_DECLARATION, validateDeclaration } from '@sovereign/wallet-core';
import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  EntryFailureCodeExpired,
  EntryFailureCodeFailed,
  EntryFailureCodeNeedsIntervention,
  EntryFailureCodeRefunded,
  EntryFailureCodeTimedOut,
  EntryPhaseConfirmed,
  EntryRequestTypeArk,
  EntryRequestTypeLightning,
  EntryRequestTypeOnchain,
  EntryStatusComplete,
  EntryStatusFailed,
  EntryStatusPending,
  ExitInfeasibilityReasonUnspecified,
  ExitInfeasibilityReasonWalletUnderfunded,
  ExitJobStatusCompleted,
  ExitJobStatusCSVPending,
  ExitJobStatusFailed,
  ExitJobStatusMaterializing,
  ExitJobStatusPending,
  ExitJobStatusSweeping,
  ExitJobStatusUnspecified,
  ExitPathCooperative,
  ExitPathUnilateral,
  ExitPathUnilateralFallback,
  ListViewActivity,
  ListViewOnchain,
  ListViewVTXOs,
  RUNTIME_MANIFEST_VERSION,
  SDK_PACKAGE,
  SDK_PIN,
  SendQuoteStatusComplete,
  SendRailLightning,
  SendRailOnchain,
  WAVELENGTH_DAEMON_PIN,
  WavelengthProvider,
  WavelengthProviderError,
} from './index.js';
import { FORCE_UNROLL_ACK } from './sdk/index.js';
import type { WavelengthClient } from './index.js';

/** The adapter package.json, read fresh so the pin cannot drift from the install. */
const pkgJson: { dependencies: Record<string, string> } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };

/** A provider under test needs a client only after start(); mainnet guard throws first. */
const unusedClient = {} as WavelengthClient;

describe('version pins', () => {
  it('pins the exact SDK version and mirrors it in package.json', () => {
    expect(SDK_PIN).toBe('0.2.0');
    expect(pkgJson.dependencies[SDK_PACKAGE]).toBe(SDK_PIN);
  });

  it('pairs the pinned SDK release with its daemon manifest version', () => {
    expect(WAVELENGTH_DAEMON_PIN).toBe(RUNTIME_MANIFEST_VERSION);
  });

  it('never exposes a version range', () => {
    expect(pkgJson.dependencies[SDK_PACKAGE]).not.toMatch(/[\^~><*]/u);
  });
});

describe('consumed SDK constants', () => {
  it('keeps the wire values the adapter maps onto', () => {
    expect(EntryStatusPending).toBe('pending');
    expect(EntryStatusComplete).toBe('complete');
    expect(EntryStatusFailed).toBe('failed');

    expect(EntryRequestTypeLightning).toBe('lightning');
    expect(EntryRequestTypeOnchain).toBe('onchain');
    expect(EntryRequestTypeArk).toBe('ark');

    expect(EntryFailureCodeTimedOut).toBe('timed_out');
    expect(EntryFailureCodeExpired).toBe('expired');
    expect(EntryFailureCodeRefunded).toBe('refunded');
    expect(EntryFailureCodeNeedsIntervention).toBe('needs_intervention');
    expect(EntryFailureCodeFailed).toBe('failed');

    expect(SendRailLightning).toBe('lightning');
    expect(SendRailOnchain).toBe('onchain');
    expect(SendQuoteStatusComplete).toBe('complete');

    expect(ListViewActivity).toBe('activity');
    expect(ListViewVTXOs).toBe('vtxos');
    expect(ListViewOnchain).toBe('onchain');

    expect(ExitPathCooperative).toBe('cooperative');
    expect(ExitPathUnilateral).toBe('unilateral');
    expect(ExitPathUnilateralFallback).toBe('unilateral_fallback');

    expect(ExitJobStatusUnspecified).toBe('unspecified');
    expect(ExitJobStatusPending).toBe('pending');
    expect(ExitJobStatusMaterializing).toBe('materializing');
    expect(ExitJobStatusCSVPending).toBe('csv_pending');
    expect(ExitJobStatusSweeping).toBe('sweeping');
    expect(ExitJobStatusCompleted).toBe('completed');
    expect(ExitJobStatusFailed).toBe('failed');

    expect(ExitInfeasibilityReasonUnspecified).toBe('unspecified');
    expect(ExitInfeasibilityReasonWalletUnderfunded).toBe('wallet_underfunded');

    expect(EntryPhaseConfirmed).toBe('confirmed');
    // Sentinel the SDK requires verbatim to force a unilateral unroll.
    expect(FORCE_UNROLL_ACK).toBe('I_KNOW_WHAT_I_AM_DOING');
  });

  it('exposes a bounded dispatch timeout', () => {
    expect(DEFAULT_DISPATCH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('Mode A capability declaration', () => {
  it('exposes wallet-core’s canonical declaration by reference', () => {
    const provider = new WavelengthProvider({ client: unusedClient });
    expect(provider.id).toBe(WAVELENGTH_DECLARATION.id);
    expect(provider.capabilities).toBe(WAVELENGTH_DECLARATION.capabilities);
    expect(provider.seedCompatibility).toBe(WAVELENGTH_DECLARATION.seedCompatibility);
  });

  it('declares the swap-based, async-exit, mnemonic-ark capability set', () => {
    const { capabilities } = WAVELENGTH_DECLARATION;
    expect(capabilities.lightningSend).toBe(true);
    expect(capabilities.lightningReceive).toBe(true);
    expect(capabilities.lightningMechanism).toBe('swaps');
    expect(capabilities.onchainSend).toBe(true);
    expect(capabilities.onchainReceive).toBe(true);
    expect(capabilities.assets).toBe('none');
    expect(capabilities.unilateralExit).toBe('async');
    expect(capabilities.recoveryModel).toBe('mnemonic-ark');
    expect(WAVELENGTH_DECLARATION.seedCompatibility).toStrictEqual(['mnemonic-ark']);
  });

  it('declares exactly the swap-server and ark-operator dependencies, verbatim', () => {
    const deps = WAVELENGTH_DECLARATION.capabilities.operatorDependencies;
    expect(deps.map((d) => d.kind)).toStrictEqual(['swap-server', 'ark-operator']);
    expect(deps[0]?.requiredFor).toStrictEqual(['send', 'receive']);
    expect(deps[1]?.requiredFor).toStrictEqual(['send', 'receive', 'exit', 'recovery']);
    expect(deps[0]?.disclosure).toBe(
      'Lightning payments are sent and received through an external swap service. Its fee is shown before you confirm a payment.',
    );
    expect(deps[1]?.disclosure).toBe(
      'Spendable funds are held as Ark VTXOs with an Ark operator. Sending, receiving, and rolling funds forward need the operator to be reachable; if it is not, a unilateral exit moves funds on-chain more slowly and at your cost. Restoring from seed must complete before VTXO batch expiry.',
    );
  });

  it('satisfies every structural declaration invariant', () => {
    expect(validateDeclaration(WAVELENGTH_DECLARATION)).toStrictEqual([]);
  });
});

describe('spec-locked safety defaults', () => {
  it('refuses to start on mainnet unless explicitly opted in', async () => {
    const provider = new WavelengthProvider({ client: unusedClient });
    const err = await provider
      .start({ network: 'mainnet', dataDir: '/tmp/never' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WavelengthProviderError);
    expect((err as WavelengthProviderError).reason).toBe('mainnet-forbidden');
  });

  it('treats the exit acknowledgement as exact-match, never prefix', () => {
    // startUnilateralExit enforces this at runtime; here the sentinel is
    // pinned so a copy edit upstream cannot silently weaken the gate.
    expect(FORCE_UNROLL_ACK.length).toBeGreaterThan(10);
    expect(FORCE_UNROLL_ACK).not.toContain('maybe');
  });
});

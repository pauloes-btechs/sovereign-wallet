// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';

import {
  BACKUP_EXPIRY_CONSEQUENCE,
  describeAssetSupport,
  describeDependencyKind,
  describeRequiredFor,
  describeSeedType,
  describeUnilateralExit,
  formatSats,
  mechanismLabel,
  satsLabel,
  vtxoStateLabel,
} from './copy.js';

describe('formatSats', () => {
  it('formats with thousands separators', () => {
    expect(formatSats(1234567n)).toBe('1,234,567');
  });

  it('formats zero and small values', () => {
    expect(formatSats(0n)).toBe('0');
    expect(formatSats(5n)).toBe('5');
  });
});

describe('satsLabel', () => {
  it('appends the unit', () => {
    expect(satsLabel(21000n)).toBe('21,000 sats');
  });
});

describe('vtxoStateLabel', () => {
  it('labels every lifecycle state in plain language', () => {
    expect(vtxoStateLabel('fresh')).toBe('Spendable');
    expect(vtxoStateLabel('expiring')).toBe('Expiring soon');
    expect(vtxoStateLabel('at-risk')).toBe('At risk');
    expect(vtxoStateLabel('exiting')).toBe('Exiting to on-chain');
  });
});

describe('mechanismLabel', () => {
  it('says "Lightning via swap service" for swaps — the Mode A copy rule', () => {
    expect(mechanismLabel('swaps')).toBe('Lightning via swap service');
  });

  it('matches the domain-layer label for channels (Mode B)', () => {
    expect(mechanismLabel('channels')).toBe('Lightning via payment channels');
  });
});

describe('disclosure label helpers', () => {
  it('labels dependency kinds and what they gate', () => {
    expect(describeDependencyKind('ark-operator')).toBe('Ark operator');
    expect(describeDependencyKind('swap-server')).toBe('Swap service');
    expect(describeRequiredFor('exit')).toBe('Emergency exit');
    expect(describeRequiredFor('recovery')).toBe('Recovery');
  });

  it('labels unilateral exit and asset support depths', () => {
    expect(describeUnilateralExit('async')).toContain('hours to days');
    expect(describeUnilateralExit('unsupported')).toContain('Not available');
    expect(describeAssetSupport('none')).toContain('Not supported');
    expect(describeSeedType('mnemonic-ark')).toBe('Ark recovery phrase');
  });
});

describe('BACKUP_EXPIRY_CONSEQUENCE', () => {
  it('carries the spec-verbatim restore-deadline warning', () => {
    expect(BACKUP_EXPIRY_CONSEQUENCE).toBe(
      'If you ever need to restore, do it promptly — waiting too long can force a slower on-chain exit.',
    );
  });
});

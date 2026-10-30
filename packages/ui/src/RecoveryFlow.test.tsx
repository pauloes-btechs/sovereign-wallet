// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecoveryFlow } from './RecoveryFlow.js';

const TWELVE_WORDS = Array.from({ length: 12 }, (_, i) => `word${i}`);

afterEach(cleanup);

describe('RecoveryFlow', () => {
  it('states the expiry deadline before any input', () => {
    render(
      <RecoveryFlow
        wordsText=""
        onWordsTextChange={() => {}}
        acceptedSeedTypes={['mnemonic-ark']}
        onRestore={() => {}}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent(
      /Restore must complete before the current VTXO batch expires/,
    );
    expect(screen.getByText(/Seeds never cross between wallet modes/)).toBeInTheDocument();
  });

  it('disables restore until at least twelve words are entered', () => {
    render(
      <RecoveryFlow
        wordsText="only three words"
        onWordsTextChange={() => {}}
        acceptedSeedTypes={['mnemonic-ark']}
        onRestore={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('refuses a cross-provider seed with an explicit explanation', () => {
    render(
      <RecoveryFlow
        wordsText={TWELVE_WORDS.join(' ')}
        onWordsTextChange={() => {}}
        acceptedSeedTypes={['mnemonic-ark']}
        rejection={{
          code: 'cross-provider-seed',
          message:
            'These words were created by the advanced (self-hosted node) mode. This everyday wallet cannot restore them — open the advanced mode instead.',
        }}
        onRestore={() => {}}
      />,
    );
    const alert = screen.getByTestId('recovery-rejection');
    expect(alert).toHaveTextContent('This phrase belongs to a different wallet mode');
    expect(alert).toHaveTextContent(/advanced \(self-hosted node\) mode/);
  });

  it('routes the operator-unreachable restore to the unilateral-exit fallback', () => {
    render(
      <RecoveryFlow
        wordsText={TWELVE_WORDS.join(' ')}
        onWordsTextChange={() => {}}
        acceptedSeedTypes={['mnemonic-ark']}
        status="restoring"
        operatorReachable={false}
        unilateralExitFallback
        onRestore={() => {}}
      />,
    );
    expect(screen.getByTestId('exit-fallback')).toHaveTextContent(
      /your funds move on-chain through a unilateral exit/,
    );
  });

  it('confirms a completed restore', () => {
    render(
      <RecoveryFlow
        wordsText={TWELVE_WORDS.join(' ')}
        onWordsTextChange={() => {}}
        acceptedSeedTypes={['mnemonic-ark']}
        status="restored"
        onRestore={() => {}}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Wallet restored.');
  });

  it('fires restore with the entered words under the parent’s control', () => {
    const onRestore = vi.fn();
    render(
      <RecoveryFlow
        wordsText={TWELVE_WORDS.join(' ')}
        onWordsTextChange={() => {}}
        acceptedSeedTypes={['mnemonic-ark']}
        onRestore={onRestore}
      />,
    );
    screen.getByRole('button', { name: 'Restore' }).click();
    expect(onRestore).toHaveBeenCalledOnce();
  });
});

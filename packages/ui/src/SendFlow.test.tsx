// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SendFlow } from './SendFlow.js';
import type { SendDraft } from './SendFlow.js';

const lightningDraft: SendDraft = {
  kind: 'lightning',
  destination: 'lnbc210n1pj…',
  amountText: '',
};

const onchainDraft: SendDraft = {
  kind: 'onchain',
  destination: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
  amountText: '21000',
};

function noop() {
  /* presentational noop */
}

afterEach(cleanup);

describe('SendFlow — copy rule', () => {
  it('labels Lightning with the declared mechanism, never "channel"', () => {
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        onReview={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getAllByText('Lightning via swap service').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/channel/i);
  });
});

describe('SendFlow — idle', () => {
  it('toggles between Lightning and on-chain drafts via the callback', () => {
    const onDraftChange = vi.fn();
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={onDraftChange}
        lightningMechanism="swaps"
        onReview={noop}
        onConfirm={noop}
      />,
    );
    screen.getByRole('tab', { name: 'On-chain' }).click();
    expect(onDraftChange).toHaveBeenCalledWith({ ...lightningDraft, kind: 'onchain' });
  });

  it('tells the user an invoice carries its own amount', () => {
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        onReview={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByText(/Invoices carry their own amount/)).toBeInTheDocument();
  });

  it('blocks Lightning send when the swap service is unreachable and says why', () => {
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        swapServiceReachable={false}
        onReview={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Swap service unreachable/);
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
  });
});

describe('SendFlow — review', () => {
  it('shows the parsed amount and the swap service fee before confirming', () => {
    const onConfirm = vi.fn();
    render(
      <SendFlow
        draft={onchainDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        status="review"
        reviewAmountSat={21_000n}
        feeQuoteSat={154n}
        onReview={noop}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText('21,000')).toBeInTheDocument();
    expect(screen.getByText('On-chain fee')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Confirm payment' }).click();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('names the swap service fee for Lightning payments', () => {
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        status="review"
        reviewAmountSat={2_100n}
        feeQuoteSat={30n}
        onReview={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByText('Swap service fee')).toBeInTheDocument();
  });
});

describe('SendFlow — outcomes', () => {
  it('shows settled state with a fresh-start action', () => {
    const onSendAnother = vi.fn();
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        status="settled"
        onReview={noop}
        onConfirm={noop}
        onSendAnother={onSendAnother}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Payment sent.');
    screen.getByRole('button', { name: 'Send another' }).click();
    expect(onSendAnother).toHaveBeenCalledOnce();
  });

  it('shows the in-flight warning while sending', () => {
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        status="sending"
        onReview={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Do not close the wallet/);
  });

  it('surfaces failure without pretending funds moved', () => {
    render(
      <SendFlow
        draft={lightningDraft}
        onDraftChange={vi.fn()}
        lightningMechanism="swaps"
        status="failed"
        errorMessage="The swap service rejected the payment."
        onReview={noop}
        onConfirm={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The swap service rejected the payment.');
  });
});

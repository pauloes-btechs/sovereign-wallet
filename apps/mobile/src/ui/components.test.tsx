/**
 * Shared components over react-native-web: tab bar accessibility, Sheet
 * close paths, QR code labelling and copy fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { PrimaryTabBar } from './navigationUi.js';
import { Sheet } from './Sheet.js';
import { QrCode } from './QrCode.js';
import { MobileAppProvider } from './appContext.js';
import { createPreferencesStore, memoryPreferencesBackend } from '../flows/preferences.js';

/** The mobile tsconfig has no DOM lib; type just what we read. */
interface DomNode {
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): { length: number };
}
const node = (el: unknown): DomNode => el as DomNode;


describe('PrimaryTabBar', () => {
  afterEach(cleanup);

  it('renders five labelled tabs, marks the active one, hides icons from assistive tech', () => {
    const onSelect = vi.fn();
    render(<PrimaryTabBar activeTab="send" onSelect={onSelect} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    expect(node(screen.getByRole('tab', { name: 'Send' })).getAttribute('aria-selected')).toBe('true');
    expect(node(screen.getByRole('tab', { name: 'Home' })).getAttribute('aria-selected')).toBe('false');
    for (const t of tabs) {
      expect(node(t).querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Wallet' }));
    expect(onSelect).toHaveBeenCalledWith('wallet');
  });
});

describe('Sheet', () => {
  afterEach(cleanup);

  it('is a labelled dialog that closes from its Close button', () => {
    const onClose = vi.fn();
    render(
      <Sheet open animated={false} title="Payment details" onClose={onClose}>
        <Text>Body</Text>
      </Sheet>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText('Payment details')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, and not at all while not dismissable', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet open animated={false} title="Fee settings" onClose={onClose}>
        <Text>Body</Text>
      </Sheet>,
    );
    fireEvent.keyUp(screen.getByText('Body'), { key: 'Escape' }); // bubbles to document
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Sheet open animated={false} title="Fee settings" onClose={onClose} dismissable={false}>
        <Text>Body</Text>
      </Sheet>,
    );
    expect(screen.queryByLabelText('Close')).toBeNull();
    fireEvent.keyUp(screen.getByText('Body'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(
      <Sheet open={false} animated={false} title="Hidden" onClose={() => undefined}>
        <Text>Not shown</Text>
      </Sheet>,
    );
    expect(screen.queryByText('Not shown')).toBeNull();
  });
});

describe('QrCode', () => {
  afterEach(cleanup);

  it('is an image with an accessible label and shows the text for copying by hand', () => {
    render(<QrCode value="bitcoin:bcrt1qexample" copyValue="bcrt1qexample" label="QR code for your address" />);
    expect(node(screen.getByLabelText('QR code for your address')).getAttribute('role')).toBe('img');
    expect(screen.getByText('bcrt1qexample')).toBeTruthy();
    // No clipboard service injected → no Copy button that would do nothing.
    expect(screen.queryByLabelText('Copy')).toBeNull();
    expect(screen.getByText('Select the text above to copy it.')).toBeTruthy();
  });

  it('copies the bare text through the injected clipboard', async () => {
    const copyText = vi.fn(() => Promise.resolve());
    render(
      <MobileAppProvider preferences={createPreferencesStore(memoryPreferencesBackend())} platform={{ copyText }}>
        <QrCode value="lightning:lnbcrt1sim" copyValue="lnbcrt1sim" label="QR code for your invoice" />
      </MobileAppProvider>,
    );
    fireEvent.click(screen.getByLabelText('Copy'));
    expect(copyText).toHaveBeenCalledWith('lnbcrt1sim');
    expect(await screen.findByLabelText('Copied')).toBeTruthy();
  });
});

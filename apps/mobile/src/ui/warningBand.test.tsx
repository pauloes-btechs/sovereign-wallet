/**
 * MobileWarningBand must never hand React Native a raw string outside <Text>:
 * on device that throws ("Text strings must be rendered within a <Text>
 * component") and takes down onboarding. Over react-native-web a <Text>
 * renders with dir="auto"; a bare <View> does not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import { MobileWarningBand } from './Primitives.js';

/** The mobile tsconfig has no DOM lib (it targets RN); type just what we read. */
interface DomNode {
  getAttribute(name: string): string | null;
  readonly parentElement: DomNode | null;
}
const node = (el: unknown): DomNode => el as DomNode;

describe('MobileWarningBand', () => {
  afterEach(cleanup);

  it('wraps a plain string child in <Text>', () => {
    render(<MobileWarningBand tone="warning">Restore promptly.</MobileWarningBand>);
    expect(node(screen.getByText('Restore promptly.')).getAttribute('dir')).toBe('auto');
  });

  it('wraps interpolated string children (array of strings) in one <Text>', () => {
    const tail = 'waiting too long can force a slower exit.';
    render(<MobileWarningBand tone="warning">Write these words down. {tail}</MobileWarningBand>);
    const el = node(screen.getByText(`Write these words down. ${tail}`));
    expect(el.getAttribute('dir')).toBe('auto');
  });

  it('passes composed children through without double-wrapping', () => {
    render(
      <MobileWarningBand tone="info">
        <Text>Wallet restored.</Text>
      </MobileWarningBand>,
    );
    const el = node(screen.getByText('Wallet restored.'));
    expect(el.getAttribute('dir')).toBe('auto');
    expect(el.parentElement?.getAttribute('dir')).not.toBe('auto');
  });
});

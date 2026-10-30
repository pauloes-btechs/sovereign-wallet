// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BACKUP_EXPIRY_CONSEQUENCE } from './copy.js';
import { BackupConfirmation } from './BackupConfirmation.js';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent'] as const;

afterEach(cleanup);

describe('BackupConfirmation', () => {
  it('shows numbered words in order', () => {
    render(<BackupConfirmation words={WORDS} step="show" onAcknowledge={vi.fn()} />);
    const words = screen.getAllByTestId('seed-word');
    expect(words).toHaveLength(WORDS.length);
    expect(words[0]).toHaveTextContent('1');
    expect(words[0]).toHaveTextContent('abandon');
    expect(words[5]).toHaveTextContent('absent');
  });

  it('masks words during verification', () => {
    render(<BackupConfirmation words={WORDS} step="verify" onBackToShow={vi.fn()} />);
    for (const word of screen.getAllByTestId('seed-word')) {
      expect(word).toHaveTextContent('•••');
      expect(word).not.toHaveTextContent('abandon');
    }
  });

  it('shows the spec-verbatim expiry-consequence on every step', () => {
    for (const step of ['show', 'verify', 'done'] as const) {
      render(<BackupConfirmation words={WORDS} step={step} />);
      expect(screen.getByTestId('expiry-consequence')).toHaveTextContent(
        BACKUP_EXPIRY_CONSEQUENCE,
      );
      cleanup();
    }
  });

  it('fires acknowledge from the show step', () => {
    const onAcknowledge = vi.fn();
    render(<BackupConfirmation words={WORDS} step="show" onAcknowledge={onAcknowledge} />);
    screen.getByRole('button', { name: 'I wrote it down' }).click();
    expect(onAcknowledge).toHaveBeenCalledOnce();
  });
});

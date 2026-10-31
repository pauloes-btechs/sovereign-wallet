/**
 * Mode B channel backups (SCB).
 *
 * Export saves the multi-channel backup blob the user must keep off-device;
 * restore is the disaster-recovery path and warns before overwriting channel
 * state on the node. The blob is opaque — the UI never parses it.
 */
import { useState } from 'react';
import { Button, Card, TextField } from '@sovereign/ui';

import { BridgeHttpError, type BridgeClient } from '../bridge-client.js';

function errorMessage(err: unknown): string {
  return err instanceof BridgeHttpError ? err.message : err instanceof Error ? err.message : String(err);
}

export function BackupsScreen({ client }: { readonly client: BridgeClient }): React.ReactNode {
  const [exported, setExported] = useState<string | null>(null);
  const [backupInput, setBackupInput] = useState('');
  const [restoreOk, setRestoreOk] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { multiChanBackupHex } = await client.exportChannelBackups();
      setExported(multiChanBackupHex);
      // Offer the blob as a file download — the artifact to keep offline.
      const blob = new Blob([multiChanBackupHex], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'channel-backup.scb.hex';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (): Promise<void> => {
    const hex = backupInput.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex) || hex.length < 8) {
      setError('Paste the multi-channel backup hex (it looks like a long hex string).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.restoreChannelBackups(hex);
      setRestoreOk(true);
      setConfirming(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card title="Channel backups (emergency recovery)">
        <p style={{ color: '#9aa0a6' }}>
          The multi-channel backup (SCB) restores your channel funds if this node's disk is lost.
          It does not replace your seed — keep BOTH. Export it again after every new channel.
        </p>
        <Button disabled={busy} onClick={() => void doExport()}>
          Export channel backup
        </Button>
        {exported !== null ? (
          <div data-testid="backup-hex" style={{ marginTop: 8 }}>
            <p style={{ color: '#3ddc97' }}>
              Backup exported ({exported.length} hex chars) and offered as a download. Store it
              somewhere offline.
            </p>
            <pre style={{ background: '#141418', border: '1px solid #2a2a30', borderRadius: 8, padding: 12, fontSize: 11, overflowX: 'auto', wordBreak: 'break-all' }}>
              {exported.length > 160 ? `${exported.slice(0, 160)}…` : exported}
            </pre>
          </div>
        ) : null}
      </Card>

      <Card title="Restore channel backups">
        {restoreOk ? (
          <p data-testid="restore-ok" style={{ color: '#3ddc97' }}>
            Restore accepted — the node is rescanning for channel funds. Keep the wallet online
            until it finishes.
          </p>
        ) : confirming ? (
          <div>
            <p style={{ color: '#f7b955' }}>
              Restoring overwrites this node's channel state with the backup's. Only do this on a
              fresh or broken node.
            </p>
            <Button variant="danger" disabled={busy} onClick={() => void doRestore()}>
              Restore now
            </Button>{' '}
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div>
            <TextField label="Backup hex" value={backupInput} onChange={setBackupInput} multiline placeholder="02020202…" />
            <Button disabled={busy} onClick={() => setConfirming(true)}>
              Restore from backup
            </Button>
          </div>
        )}
        {error !== null ? (
          <p data-testid="backup-error" style={{ color: '#ff6b6b' }}>{error}</p>
        ) : null}
      </Card>
    </div>
  );
}

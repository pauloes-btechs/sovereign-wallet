/**
 * Security & recovery. Channel backup export is live (GET /channel-backups).
 * Restore (POST /channel-backups/restore) is wired but gated behind a strong
 * warning and a typed confirmation, because restoring makes peers
 * force-close every channel in the backup.
 */
import { useState } from 'react';
import { usePlatform } from '../../context.js';
import { Link } from '../../router.js';
import { Badge, Field, Icon, Notice, PageHeader, Panel, relativeTime } from '../../ui.js';
import { CopyButton, Fact, Facts } from './components.js';

const CONFIRM_PHRASE = 'force close my channels';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export default function SecurityPage() {
  const { bridge, node } = usePlatform();
  const [backup, setBackup] = useState<{ hex: string; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportBackup = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await bridge.exportChannelBackups();
      setBackup({ hex: r.multiChanBackupHex, at: Date.now() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (backup === null) return;
    const bytes = hexToBytes(backup.hex);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `channel-${new Date(backup.at).toISOString().slice(0, 10)}.backup`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const channels = (node.info?.numActiveChannels ?? 0) + (node.info?.numInactiveChannels ?? 0) + (node.info?.numPendingChannels ?? 0);

  return (
    <>
      <PageHeader title="Security & recovery" sub="What it takes to get your funds back if this computer is lost, and the backups that make it possible." />
      <div className="p-stack">
        <div className="p-grid">
          <div className="p-span-7">
            <Panel
              title="Channel backup"
              note="A static channel backup (SCB) lists your channels and peers, encrypted with your seed."
            >
              <div className="p-stack">
                {error ? (
                  <Notice tone="danger" title="Couldn't export the channel backup" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void exportBackup()}>Retry</button>}>
                    {error}
                  </Notice>
                ) : null}
                <div className="p-row">
                  <button type="button" className="p-btn p-btn-primary" onClick={() => void exportBackup()} disabled={busy}>
                    <Icon name="arrowDown" />
                    {busy ? 'Exporting…' : 'Export channel backup'}
                  </button>
                  {backup ? <span className="p-muted" style={{ fontSize: 13 }}>Export again after opening or closing a channel.</span> : null}
                </div>
                {backup === null ? (
                  <div className="ac-prose">
                    <p>
                      Export a fresh backup after every channel open or close and keep it somewhere other than this computer. It covers{' '}
                      <strong>{channels.toLocaleString('en-US')}</strong> {channels === 1 ? 'channel' : 'channels'} right now. On its own it&apos;s useless: it can only
                      be decrypted with this wallet&apos;s seed.
                    </p>
                  </div>
                ) : (
                  <>
                    <Facts>
                      <Fact label="Exported">{relativeTime(backup.at)} · {(backup.hex.length / 2).toLocaleString('en-US')} bytes</Fact>
                      <Fact label="Covers">{channels.toLocaleString('en-US')} {channels === 1 ? 'channel' : 'channels'} at export time</Fact>
                    </Facts>
                    <div className="p-copy">
                      <code data-testid="backup-hex" aria-label="Channel backup (hex)" style={{ maxHeight: 96, overflowY: 'auto' }}>
                        {backup.hex}
                      </code>
                    </div>
                    <div className="p-row">
                      <button type="button" className="p-btn" onClick={download}>
                        <Icon name="arrowDown" />
                        Download backup file
                      </button>
                      <CopyButton value={backup.hex} label="Copy as hex" />
                    </div>
                    <p className="p-hint" style={{ margin: 0 }}>
                      The file is LND&apos;s multi-channel backup format, the same as <span className="p-mono">channel.backup</span>; the hex is the same bytes.
                    </p>
                  </>
                )}
              </div>
            </Panel>
          </div>
          <div className="p-span-5">
            <Panel title="Recovery seed">
              <div className="ac-prose">
                <p>
                  This wallet&apos;s seed is a 24-word <strong>aezeed</strong> mnemonic, plus an optional passphrase. aezeed also records the wallet&apos;s birthday,
                  so a restore only rescans the chain from when the wallet was created.
                </p>
                <p>
                  The seed was shown once, when the wallet was created. This app never stores it and can&apos;t show it again. If you didn&apos;t write it down,
                  move your funds to a new wallet whose seed you have backed up.
                </p>
                <p>To restore, start the app with an empty node and choose to restore from seed during setup, then restore your channel backup on this page.</p>
              </div>
            </Panel>
          </div>
        </div>

        <Panel title="What can be recovered from what" note="Restore needs the seed in every case. Some funds need more." flush>
          <div className="p-table-wrap">
            <table className="p-table">
              <thead>
                <tr>
                  <th>Funds or data</th>
                  <th>Seed only</th>
                  <th>Seed + channel backup</th>
                  <th>Also needs</th>
                </tr>
              </thead>
              <tbody>
                <MatrixRow what="On-chain bitcoin" seed="yes" scb="yes" also="Nothing else. The chain is rescanned from the seed's birthday." />
                <MatrixRow
                  what="Lightning channel balances"
                  seed="no"
                  scb="partial"
                  also="Peers must be online and honest. They force-close each channel and pay out your side on-chain after a timelock. Fees and the wait apply."
                  scbNote="Via force close"
                />
                <MatrixRow what="Payments in flight (HTLCs)" seed="no" scb="no" also="Can be lost if the node is gone mid-payment." />
                <MatrixRow what="Loop swaps in progress" seed="no" scb="no" also="loopd's database (Loop data directory) while a swap is running." />
                <MatrixRow
                  what="Pool accounts"
                  seed="partial"
                  scb="partial"
                  also="poold can find accounts derived from the seed, but only with the auctioneer reachable. Back up the Pool data directory too."
                  seedNote="With the auctioneer"
                  scbNote="With the auctioneer"
                />
                <MatrixRow
                  what="Taproot Assets"
                  seed="no"
                  scb="no"
                  also="The asset proofs in tapd's data directory, or a universe server that holds them. The seed restores keys, not proofs."
                />
                <MatrixRow what="App preferences" seed="no" scb="no" also="Nothing worth restoring: they live on this device only." />
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="p-grid">
          <div className="p-span-7">
            <RestorePanel />
          </div>
          <div className="p-span-5">
            <Panel title="App lock">
              <div className="p-stack">
                <Notice tone="warning" title="App lock isn't available in this build">
                  There is no inactivity lock or PIN on this interface. Anyone using this computer while the app is open can see balances and move funds.
                </Notice>
                <Facts>
                  <Fact label="Wallet password" help="Encrypts LND's wallet on disk. Asked for every time the node starts.">
                    <Badge tone="positive">On</Badge>
                  </Fact>
                  <Fact label="App to node access" help="A random token generated at each launch; the bridge only listens on 127.0.0.1.">
                    Per-launch token
                  </Fact>
                  <Fact label="Lock the wallet while running" help="LND can't re-lock a running wallet; stopping the node locks it.">
                    Not supported
                  </Fact>
                </Facts>
                <p className="p-hint" style={{ margin: 0 }}>
                  See <Link to="/privacy" className="ac-link">Privacy</Link> for what this app and node connect to.
                </p>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

type Mark = 'yes' | 'no' | 'partial';

function MarkCell({ mark, note }: { mark: Mark; note?: string }) {
  const label = mark === 'yes' ? 'Yes' : mark === 'no' ? 'No' : 'Partly';
  const icon = mark === 'yes' ? 'check' : mark === 'no' ? 'close' : 'warning';
  return (
    <td>
      <span className={mark === 'yes' ? 'ac-yes' : mark === 'no' ? 'ac-no' : 'ac-partial'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name={icon} size={16} />
        {label}
      </span>
      {note ? <span className="ac-cell-note">{note}</span> : null}
    </td>
  );
}

function MatrixRow({ what, seed, scb, also, seedNote, scbNote }: { what: string; seed: Mark; scb: Mark; also: string; seedNote?: string; scbNote?: string }) {
  return (
    <tr>
      <td style={{ fontWeight: 500 }}>{what}</td>
      <MarkCell mark={seed} note={seedNote} />
      <MarkCell mark={scb} note={scbNote} />
      <td className="p-muted" style={{ fontSize: 13, maxWidth: 420 }}>{also}</td>
    </tr>
  );
}

function RestorePanel() {
  const { bridge, toast, bumpRefresh } = usePlatform();
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  const hexError = clean === '' ? null : !/^[0-9a-f]+$/.test(clean) ? 'Only hex characters (0-9, a-f) are allowed.' : clean.length % 2 !== 0 ? 'Hex must have an even number of characters.' : null;
  const ready = clean !== '' && hexError === null && typed.trim().toLowerCase() === CONFIRM_PHRASE;

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await bridge.restoreChannelBackups(clean);
      toast({ title: 'Channel backup restored', body: 'Peers will force-close the restored channels.', tone: 'info' });
      bumpRefresh();
      setHex('');
      setTyped('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Restore from a channel backup" note="For recovering a lost node's channels into a freshly restored wallet.">
      <div className="p-stack">
        <div className="ac-prose">
          <p>
            Restoring doesn&apos;t bring channels back to life. LND contacts each peer in the backup and asks it to <strong>force-close</strong> the channel, then
            sweeps your side on-chain once the timelock expires. Every channel in the backup is closed for good.
          </p>
          <p>Only do this on a wallet restored from seed after losing the original node. Never on a node whose channels are still working.</p>
        </div>
        {!open ? (
          <div>
            <button type="button" className="p-btn p-btn-danger" onClick={() => setOpen(true)}>
              Restore channel backup…
            </button>
          </div>
        ) : (
          <>
            <Notice tone="danger" title="This closes every channel in the backup">
              Channels are force-closed, funds are locked until their timelocks expire, and on-chain fees are paid. It can&apos;t be undone.
            </Notice>
            <Field label="Channel backup (hex)" hint="Paste the hex from an earlier export." error={hexError}>
              {(id) => <textarea id={id} className="p-textarea p-mono" rows={3} value={hex} onChange={(e) => setHex(e.target.value)} spellCheck={false} />}
            </Field>
            <Field label={`Type “${CONFIRM_PHRASE}” to confirm`}>
              {(id) => <input id={id} className="p-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
            </Field>
            {error ? <Notice tone="danger" title="Restore failed">{error}</Notice> : null}
            <div className="p-row">
              <button
                type="button"
                className="p-btn p-btn-ghost"
                onClick={() => {
                  setOpen(false);
                  setHex('');
                  setTyped('');
                }}
              >
                Cancel
              </button>
              <button type="button" className="p-btn p-btn-danger" disabled={!ready || busy} onClick={() => void restore()}>
                {busy ? 'Restoring…' : 'Restore and force-close channels'}
              </button>
              {!ready ? <span className="ac-reason">Paste a backup and type the phrase to continue.</span> : null}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

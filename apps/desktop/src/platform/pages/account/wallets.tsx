/**
 * Wallets — this node wallet (advanced mode) and the everyday Wavelength
 * mode. Node facts come from GET /state and GET /services; the mode
 * comparison mirrors the provider declarations in
 * packages/wallet-core/src/capabilities.ts (WAVELENGTH_DECLARATION,
 * LITD_LOCAL_DECLARATION), which aren't exported from the package yet.
 */
import { usePlatform } from '../../context.js';
import { Link } from '../../router.js';
import { Badge, Icon, PageHeader, Panel } from '../../ui.js';
import { Fact, Facts, IdCopy } from './components.js';

type Cap = { label: string; advanced: string; everyday: string; advancedOk: boolean; everydayOk: boolean };

const CAPS: readonly Cap[] = [
  { label: 'Lightning payments', advanced: 'Through your own payment channels', everyday: 'Through a swap service', advancedOk: true, everydayOk: true },
  { label: 'On-chain bitcoin', advanced: 'Send and receive', everyday: 'Send and receive', advancedOk: true, everydayOk: true },
  { label: 'Open and close channels', advanced: 'Yes', everyday: 'No channels to manage', advancedOk: true, everydayOk: false },
  { label: 'Loop, Pool and routing', advanced: 'Yes, via litd', everyday: 'Not available', advancedOk: true, everydayOk: false },
  { label: 'Taproot Assets', advanced: 'On-chain (layer 1)', everyday: 'Not available', advancedOk: true, everydayOk: false },
  { label: 'If the operator disappears', advanced: 'No operator. Force-close channels at any time', everyday: 'Unilateral exit to on-chain: slower, at your cost', advancedOk: true, everydayOk: true },
  { label: 'Recovery', advanced: 'aezeed seed + channel backup', everyday: 'Wavelength seed, before the VTXO batch expires', advancedOk: true, everydayOk: true },
];

export default function WalletsPage() {
  const { node, services } = usePlatform();
  const info = node.info;
  const network = services.data?.network ?? info?.chains[0]?.network ?? '';

  return (
    <>
      <PageHeader title="Wallets" sub="This wallet runs your own Lightning node. Sovereign Wallet also has an everyday mode that needs no node at all." />
      <div className="p-stack">
        <div className="p-grid">
          <div className="p-span-7">
            <Panel
              title="This node wallet"
              note="Advanced mode · Lightning Terminal (litd)"
              actions={<Badge tone="positive">In use</Badge>}
            >
              <Facts>
                <Fact label="Alias">{info?.alias ?? '—'}</Fact>
                <Fact label="Node public key" help="Your identity on the Lightning network. Safe to share.">
                  {info ? <IdCopy value={info.identityPubkey} what="node public key" head={14} tail={10} /> : '—'}
                </Fact>
                <Fact label="Network">{network ? <Badge tone={network === 'mainnet' ? 'accent' : 'info'}>{network}</Badge> : '—'}</Fact>
                <Fact label="Software"><span className="p-mono">{info?.version ?? '—'}</span></Fact>
                <Fact label="Channels">
                  {info
                    ? `${info.numActiveChannels} active · ${info.numPendingChannels} pending · ${info.numInactiveChannels} inactive`
                    : '—'}
                </Fact>
                <Fact label="Peers">{info ? info.numPeers.toLocaleString('en-US') : '—'}</Fact>
                <Fact label="Seed type" help="Different from the everyday mode's seed; the two can't be restored into each other.">
                  aezeed (24 words) + channel backup
                </Fact>
              </Facts>
            </Panel>
          </div>
          <div className="p-span-5">
            <Panel title="Everyday mode" note="Wavelength · no node to run" actions={<Badge tone="neutral">Separate wallet</Badge>}>
              <div className="ac-mode-card">
                <div className="ac-prose">
                  <p>
                    For day-to-day spending. Your balance is held as Ark VTXOs with an Ark operator, and Lightning payments go through a swap service, so there
                    are no channels, liquidity or node to look after.
                  </p>
                  <p>
                    It is a <strong>different wallet with its own seed</strong>. Nothing moves between the two modes automatically; send funds from one to the
                    other like any payment.
                  </p>
                </div>
                <div>
                  <a href="?mode=a" className="p-btn">
                    <Icon name="external" />
                    Open everyday mode
                  </a>
                  <div className="p-hint" style={{ marginTop: 6 }}>
                    Reopens the app with <span className="p-mono">?mode=a</span>. Come back with <span className="p-mono">?mode=b</span>.
                  </div>
                </div>
              </div>
            </Panel>
          </div>
        </div>

        <Panel title="What each mode can do" note="From each mode's declared capabilities, not from what it happens to be doing now." flush>
          <div className="p-table-wrap">
            <table className="p-table">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Advanced (this node)</th>
                  <th>Everyday (Wavelength)</th>
                </tr>
              </thead>
              <tbody>
                {CAPS.map((c) => (
                  <tr key={c.label}>
                    <td style={{ fontWeight: 500 }}>{c.label}</td>
                    <CapCell ok={c.advancedOk} text={c.advanced} />
                    <CapCell ok={c.everydayOk} text={c.everyday} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="p-grid">
          <div className="p-span-6">
            <Panel title="Everyday mode depends on">
              <ul className="ac-points">
                <li>
                  <strong>Swap service:</strong> Lightning payments are sent and received through an external swap service. Its fee is shown before you confirm a
                  payment.
                </li>
                <li>
                  <strong>Ark operator:</strong> spendable funds are held as Ark VTXOs with an Ark operator. Sending, receiving and rolling funds forward need the
                  operator to be reachable; if it is not, a unilateral exit moves funds on-chain more slowly and at your cost. Restoring from seed must complete
                  before VTXO batch expiry.
                </li>
              </ul>
              <p className="p-hint" style={{ margin: '12px 0 0' }}>
                There is no public regtest Ark operator, so everyday mode can&apos;t move money on this regtest setup.
              </p>
            </Panel>
          </div>
          <div className="p-span-6">
            <Panel title="New or restored node wallet">
              <div className="ac-prose">
                <p>
                  A node holds one wallet. Creating or restoring happens in setup, before the node unlocks, so it can&apos;t be done from inside a running wallet.
                </p>
              </div>
              <ol className="ac-points">
                <li>Export a fresh <Link to="/security">channel backup</Link> and make sure you have this wallet&apos;s seed.</li>
                <li>Start the app with a new, empty node data directory.</li>
                <li>Choose <strong>Restore</strong> and enter the 24-word aezeed seed (and passphrase, if you set one).</li>
                <li>Once the node is running, restore the channel backup from <Link to="/security">Security &amp; recovery</Link>; peers force-close those channels and pay out your side.</li>
              </ol>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

function CapCell({ ok, text }: { ok: boolean; text: string }) {
  return (
    <td>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span className={ok ? 'ac-yes' : 'p-faint'} style={{ display: 'inline-flex' }} aria-label={ok ? 'Supported' : 'Not supported'} role="img">
          <Icon name={ok ? 'check' : 'close'} size={16} />
        </span>
        <span className={ok ? undefined : 'p-muted'}>{text}</span>
      </span>
    </td>
  );
}

import { usePrefs } from '../../context.js';
import { Link } from '../../router.js';
import { Amount, Badge, Empty, Icon, LiquidityBar, Notice, PageHeader, Panel, Segmented, Skeleton, shortId } from '../../ui.js';
import type { ChannelRowView } from '../../../modeb/bridge-client.js';
import { BalanceSplit, HeroFigure, KV, RetryButton, lightningHeld, onchainHeld, useBalances } from '../overview/shared.js';

const CHANNEL_STATE: Record<ChannelRowView['state'], { label: string; tone: 'positive' | 'warning' | 'info' | 'neutral' }> = {
  open: { label: 'Active', tone: 'positive' },
  'open-inactive': { label: 'Inactive', tone: 'warning' },
  opening: { label: 'Opening', tone: 'info' },
  closing: { label: 'Closing', tone: 'neutral' },
  'closing-force': { label: 'Force closing', tone: 'warning' },
  'waiting-close': { label: 'Waiting to close', tone: 'neutral' },
};

export default function BitcoinPage() {
  const prefs = usePrefs();
  const b = useBalances();
  const a = b.accounts;
  const channels = b.channels.data;
  const allChannels = channels ? [...channels.open, ...channels.pending] : [];

  return (
    <>
      <PageHeader
        title="Bitcoin"
        sub="Your BTC on-chain and in Lightning channels, in one place."
        actions={
          <>
            <Segmented
              label="Denomination"
              value={prefs.unit}
              onChange={(unit) => prefs.set({ unit })}
              options={[
                { value: 'sats', label: 'sats' },
                { value: 'btc', label: 'BTC' },
              ]}
            />
            <Link to="/receive" className="p-btn">
              <Icon name="receive" />
              Receive
            </Link>
            <Link to="/send" className="p-btn p-btn-primary">
              <Icon name="send" />
              Send
            </Link>
          </>
        }
      />
      {b.error && !a ? (
        <Notice tone="danger" title="Balances could not be loaded" action={<RetryButton onClick={b.reload} />}>
          {b.error}
        </Notice>
      ) : !a || !b.segments ? (
        <div className="p-grid">
          <div className="p-span-12">
            <Skeleton height={220} />
          </div>
          <div className="p-span-6">
            <Skeleton height={220} />
          </div>
          <div className="p-span-6">
            <Skeleton height={220} />
          </div>
        </div>
      ) : (
        <div className="p-grid">
          <Panel className="p-span-12">
            <div className="ov-hero">
              <div className="ov-hero-top">
                <HeroFigure sats={a.totalSat} label="Bitcoin holdings" />
                <div className="ov-hero-side">
                  <div className="p-stat-label">On-chain</div>
                  <div className="ov-cap-value">
                    <Amount sats={onchainHeld(a)} />
                  </div>
                  <div className="p-stat-label" style={{ marginTop: 'var(--sovl-space-2)' }}>
                    Lightning
                  </div>
                  <div className="ov-cap-value">
                    <Amount sats={lightningHeld(a)} />
                  </div>
                </div>
              </div>
              <LiquidityBar size="lg" segments={b.segments} />
              <BalanceSplit accounts={a} />
            </div>
          </Panel>

          <Panel
            title="On-chain"
            note="Funds in your LND wallet, secured by your seed"
            className="p-span-6 ov-fill"
          >
            <KV
              rows={[
                { k: 'Spendable', hint: 'Confirmed and free to spend', v: <Amount sats={a.onchainSpendableSat} /> },
                { k: 'Unconfirmed', hint: 'Waiting for a block', v: <Amount sats={a.onchainUnconfirmedSat} /> },
                { k: 'Locked and anchor reserve', hint: 'Kept back for fee bumps and in-progress operations', v: <Amount sats={a.onchainLockedSat} /> },
              ]}
            />
            <div className="ov-receive">
              <div>
                <div className="ov-health-name">Deposit bitcoin</div>
                <div className="p-hint">Generate a fresh address on the Receive page. Each address is new, which keeps your history private.</div>
              </div>
              <Link to="/receive" className="p-btn p-btn-primary p-btn-sm">
                <Icon name="plus" />
                New address
              </Link>
            </div>
            <div className="ov-acct-actions">
              <Link to="/send" className="p-btn p-btn-sm">
                <Icon name="send" />
                Send on-chain
              </Link>
              <Link to="/loop/in" className="p-btn p-btn-sm">
                <Icon name="bolt" />
                Move to Lightning
              </Link>
            </div>
          </Panel>

          <Panel
            title="Lightning"
            note="Your side of your payment channels"
            className="p-span-6 ov-fill"
            actions={
              <Link to="/channels" className="p-btn p-btn-ghost p-btn-sm">
                Channels
              </Link>
            }
          >
            <KV
              rows={[
                { k: 'Spendable', hint: 'What you can send now', v: <Amount sats={a.lightningSpendableSat} /> },
                { k: 'Opening and in flight', hint: 'Channels confirming, payments settling', v: <Amount sats={a.channelsOpeningSat + a.lightningInFlightSat} /> },
                { k: 'Receivable', hint: "Peers' side; not counted as yours", v: <span className="p-muted"><Amount sats={a.lightningReceivableSat} /></span> },
              ]}
            />
            <div className="ov-receive" style={{ display: 'block', borderStyle: 'solid' }}>
              <div className="p-spread" style={{ marginBottom: 'var(--sovl-space-2)' }}>
                <span className="p-stat-label">Send capacity</span>
                <span className="p-stat-label">Receive capacity</span>
              </div>
              <LiquidityBar
                legend={false}
                segments={[
                  { kind: 'outbound', sats: a.lightningSpendableSat },
                  { kind: 'inbound', sats: a.lightningReceivableSat },
                ]}
              />
              <div className="p-hint" style={{ marginTop: 'var(--sovl-space-2)' }}>
                Sending moves the split toward receive capacity; receiving moves it back.
              </div>
            </div>
            <div className="ov-acct-actions">
              <Link to="/send" className="p-btn p-btn-sm">
                <Icon name="send" />
                Pay an invoice
              </Link>
              <Link to="/loop/out" className="p-btn p-btn-sm">
                <Icon name="chain" />
                Move on-chain
              </Link>
            </div>
          </Panel>

          <Panel title="Channels" note="Where your Lightning bitcoin sits, channel by channel" flush className="p-span-12">
            {allChannels.length === 0 ? (
              <Empty title="No channels yet" action={<Link to="/channels" className="p-btn p-btn-sm">Open a channel</Link>}>
                Lightning funds live in channels. Open one to move bitcoin into Lightning.
              </Empty>
            ) : (
              <div className="p-table-wrap" style={{ marginTop: 'var(--sovl-space-3)' }}>
                <table className="p-table ov-table">
                  <thead>
                    <tr>
                      <th>Peer</th>
                      <th className="ov-tight">State</th>
                      <th>Balance</th>
                      <th className="p-num ov-tight">Yours</th>
                      <th className="p-num ov-tight">Receivable</th>
                      <th className="p-num ov-tight">Capacity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allChannels.map((c) => {
                      const st = CHANNEL_STATE[c.state];
                      return (
                        <tr key={c.channelPoint}>
                          <td>
                            <div className="ov-peer" style={{ whiteSpace: 'nowrap' }}>
                              <span className="p-mono" title={c.remotePubkey}>
                                {shortId(c.remotePubkey, 8, 6)}
                              </span>
                              <span className="p-hint">{c.initiatorLabel}</span>
                            </div>
                          </td>
                          <td className="ov-tight">
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </td>
                          <td className="ov-chan-bar">
                            <LiquidityBar
                              legend={false}
                              ariaLabel={`${c.localBalanceSat} sats yours, ${c.remoteBalanceSat} sats receivable`}
                              segments={[
                                { kind: 'outbound', sats: Number(c.localBalanceSat) },
                                { kind: 'inbound', sats: Number(c.remoteBalanceSat) },
                              ]}
                            />
                          </td>
                          <td className="p-num">
                            <Amount sats={c.localBalanceSat} />
                          </td>
                          <td className="p-num p-muted">
                            <Amount sats={c.remoteBalanceSat} />
                          </td>
                          <td className="p-num p-muted">
                            <Amount sats={c.capacitySat} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="ov-foot-note">
              <Icon name="info" size={14} />
              Yours plus receivable can be slightly less than capacity: the difference is the channel&apos;s commitment fee and anchor outputs.
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}

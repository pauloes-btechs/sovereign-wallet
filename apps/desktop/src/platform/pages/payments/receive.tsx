/**
 * Receive: a Lightning invoice (QR + live status until paid) or an on-chain
 * deposit address (QR as a BIP21 URI, with the incoming deposit tracked by
 * polling the wallet balance).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { WalletBalanceView } from '../../../modeb/bridge-client.js';
import { computeAccounts } from '../../balances.js';
import { usePlatform, usePoll } from '../../context.js';
import { Link, useLocation } from '../../router.js';
import { Amount, Field, Icon, LiquidityBar, Notice, PageHeader, Panel, QrCode, Segmented, Skeleton, Stat, Timeline, type StepState } from '../../ui.js';
import { InvoiceCreator, InvoiceLive, useReceiveCapacity, type CreatedInvoice } from './receive-invoice.js';
import { CopyValue, Details, errorText, readSats } from './send-kit.js';

type Tab = 'lightning' | 'onchain';

export default function ReceivePage() {
  const path = useLocation();
  const tab: Tab = path.startsWith('/receive/onchain') ? 'onchain' : 'lightning';
  return (
    <>
      <PageHeader title="Receive" sub="Request a Lightning payment, or get a Bitcoin address for an on-chain deposit." />
      <nav className="p-tabs" aria-label="Receive method">
        <Link to="/receive" aria-current={tab === 'lightning' ? 'page' : undefined}>
          Lightning
        </Link>
        <Link to="/receive/onchain" aria-current={tab === 'onchain' ? 'page' : undefined}>
          On-chain
        </Link>
      </nav>
      {tab === 'lightning' ? <LightningReceive /> : <OnchainReceive />}
    </>
  );
}

// ——— Lightning ———

function LightningReceive() {
  const [invoice, setInvoice] = useState<CreatedInvoice | null>(null);
  return (
    <div className="p-grid">
      <div className="p-span-8 p-stack">
        <Panel title={invoice ? 'Lightning invoice' : 'Create a Lightning invoice'} note={invoice ? 'Show the QR code or copy the invoice. It can be paid once.' : 'An invoice is a one-time payment request. Nothing reaches the network until someone pays it.'}>
          {invoice ? <InvoiceLive key={invoice.rHashHex} invoice={invoice} onNew={() => setInvoice(null)} /> : <InvoiceCreator onCreated={setInvoice} />}
        </Panel>
        <Panel title="Recent requests" actions={<Link to="/requests" className="p-btn p-btn-sm p-btn-ghost">All payment requests</Link>}>
          <RecentInvoices />
        </Panel>
      </div>
      <div className="p-span-4 p-stack">
        <CapacityPanel />
      </div>
    </div>
  );
}

function RecentInvoices() {
  const { api, refreshKey } = usePlatform();
  const inv = usePoll(() => api.invoices(), 10_000, [refreshKey]);
  if (inv.loading && !inv.data) return <Skeleton height={60} />;
  if (inv.error && !inv.data) {
    return (
      <Notice tone="danger" title="Couldn't load invoices" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void inv.reload()}>Retry</button>}>
        {inv.error}
      </Notice>
    );
  }
  const recent = [...(inv.data ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  if (recent.length === 0) return <p className="p-muted" style={{ margin: 0 }}>No invoices yet. Invoices you create appear here and on Payment requests.</p>;
  return (
    <div className="sw-details">
      {recent.map((i) => (
        <div key={i.paymentHashHex} className="sw-details-row">
          <dt className="sw-truncate">{i.memo || (i.isKeysend ? 'Keysend payment' : 'No memo')}</dt>
          <dd>
            <Amount sats={i.state === 'settled' ? i.paidSat : i.valueSat} /> <span className="p-faint">· {i.state === 'settled' ? 'paid' : i.state === 'open' && i.expiresAt < Date.now() ? 'expired' : i.state === 'open' ? 'awaiting payment' : i.state}</span>
          </dd>
        </div>
      ))}
    </div>
  );
}

function CapacityPanel() {
  const cap = useReceiveCapacity();
  const { channels } = cap;
  const accounts = useMemo(() => computeAccounts(undefined, channels.data), [channels.data]);
  return (
    <Panel title="How much you can receive">
      {channels.loading && !channels.data ? (
        <Skeleton height={80} />
      ) : channels.error && !channels.data ? (
        <Notice tone="danger" title="Couldn't load channels" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void channels.reload()}>Retry</button>}>
          {channels.error}
        </Notice>
      ) : (
        <div className="p-stack">
          <Stat label="Receivable over Lightning" foot={`Across ${cap.activeCount} active channel${cap.activeCount === 1 ? '' : 's'}`}>
            <Amount sats={cap.receivableSat} />
          </Stat>
          <LiquidityBar
            segments={[
              { kind: 'outbound', sats: accounts.lightningSpendableSat },
              { kind: 'inbound', sats: accounts.lightningReceivableSat },
            ]}
          />
          <Details rows={[{ label: 'Largest in one channel', value: <Amount sats={cap.largestSat} /> }]} />
          <p className="p-hint" style={{ margin: 0 }}>
            Lightning can only receive up to your channels' remote side (inbound liquidity). Each peer also keeps a reserve, about 1% of the channel, that can't move, so the real limit is
            slightly lower. Need more? Buy inbound in <Link className="sw-link" to="/pool">Pool</Link> or make room with a <Link className="sw-link" to="/loop">Loop Out</Link>.
          </p>
          {cap.activeCount === 0 ? (
            <Notice tone="warning" title="No active channels">
              You can create invoices, but nobody can pay them until you have an open channel with inbound liquidity. Use the On-chain tab to receive without a channel.
            </Notice>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

// ——— On-chain ———

type AddrType = 'p2wkh' | 'np2wkh';

function btcString(sats: number): string {
  // Exact decimal BTC without float drift: 8 places, trailing zeros trimmed.
  const whole = Math.floor(sats / 100_000_000);
  const frac = String(sats % 100_000_000).padStart(8, '0').replace(/0+$/, '');
  return frac === '' ? String(whole) : `${whole}.${frac}`;
}

function OnchainReceive() {
  const { bridge, services, refreshKey } = usePlatform();
  const [type, setType] = useState<AddrType>('p2wkh');
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const amt = readSats(amount);

  const wallet = usePoll(() => bridge.walletBalance(), 5000, [refreshKey]);
  const baseline = useRef<WalletBalanceView | null>(null);
  useEffect(() => {
    if (address !== null && baseline.current === null && wallet.data) baseline.current = wallet.data;
  }, [address, wallet.data]);

  const newAddress = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.newAddress(type);
      setAddress(res.address);
      baseline.current = wallet.data ?? null;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const uri = address === null ? '' : `bitcoin:${address}${amt.value ? `?amount=${btcString(amt.value)}` : ''}`;
  const base = baseline.current;
  const unconfNow = Number(wallet.data?.unconfirmedSat ?? 0);
  const confNow = Number(wallet.data?.confirmedSat ?? 0);
  const incoming = base !== null && unconfNow > Number(base.unconfirmedSat);
  const confirmedUp = base !== null && confNow > Number(base.confirmedSat);
  const steps: { title: string; body: string; state: StepState }[] = [
    { title: 'Address ready', body: 'Share it with the sender. Each address should be used once.', state: address ? 'done' : 'current' },
    {
      title: 'Seen on the network',
      body: incoming ? 'An incoming transaction is waiting for a block.' : 'A full-node backend shows it within seconds. With Neutrino (a light client, this app\u2019s default) it appears only once mined.',
      state: incoming || confirmedUp ? 'done' : address ? 'current' : 'pending',
    },
    {
      title: 'Confirmed and spendable',
      body: confirmedUp ? 'The deposit is in a block and can be spent or used to open a channel.' : 'After 1 confirmation, about 10 minutes on mainnet.',
      state: confirmedUp ? 'done' : incoming ? 'current' : 'pending',
    },
  ];

  return (
    <div className="p-grid">
      <div className="p-span-8 p-stack">
        <Panel
          title="Deposit address"
          note="Addresses come from your node's wallet. A fresh one for each deposit keeps your payments harder to link."
          actions={
            <span className="sw-seg-nowrap">
            <Segmented<AddrType>
              label="Address type"
              value={type}
              onChange={(v) => setType(v)}
              options={[
                { value: 'p2wkh', label: 'Native SegWit' },
                { value: 'np2wkh', label: 'Nested SegWit' },
              ]}
            />
            </span>
          }
        >
          {address === null ? (
            <div className="p-stack">
              <p className="p-muted" style={{ margin: 0 }}>
                {type === 'p2wkh'
                  ? 'Native SegWit (bech32) addresses have the lowest fees. Use this unless the sender’s wallet can’t pay to it.'
                  : 'Nested SegWit addresses work with older wallets that can’t send to bech32, at slightly higher fees when you spend.'}
              </p>
              <div className="p-row">
                <button type="button" className="p-btn p-btn-primary" disabled={busy} onClick={() => void newAddress()}>
                  {busy ? 'Generating…' : 'New address'}
                </button>
              </div>
            </div>
          ) : (
            <div className="sw-qr-layout">
              <QrCode value={uri} size={208} label="Bitcoin address QR code" />
              <div className="p-stack" style={{ gap: 14 }}>
                <Field label="Bitcoin address">{() => <CopyValue value={address} label="Bitcoin address" testId="receive-address" />}</Field>
                <Field label="Request an amount (optional)" error={amt.error ?? null} hint="Adds the amount to the QR code (BIP21). The sender can still change it.">
                  {(id) => (
                    <div className="p-input-affix" style={{ maxWidth: 260 }}>
                      <input id={id} className="p-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
                      <span>sats</span>
                    </div>
                  )}
                </Field>
                {amt.value ? <Field label="Payment link">{() => <CopyValue value={uri} label="Payment link" />}</Field> : null}
                <div className="p-row">
                  <button type="button" className="p-btn p-btn-sm" disabled={busy} onClick={() => void newAddress()}>
                    <Icon name="refresh" /> New address
                  </button>
                  <span className="p-hint">{type === 'p2wkh' ? 'Native SegWit (bech32)' : 'Nested SegWit (P2SH)'} · network: {services.data?.network ?? '…'}</span>
                </div>
              </div>
            </div>
          )}
          {error !== null ? (
            <div style={{ marginTop: 16 }}>
              <Notice tone="danger" title="Couldn't get a new address">
                {error}
              </Notice>
            </div>
          ) : null}
        </Panel>
        {services.data?.network === 'mainnet' ? null : services.data ? (
          <Notice tone="info" title={`This node runs on ${services.data.network}`}>
            Only send {services.data.network} coins to this address. Real bitcoin sent here would be lost.
          </Notice>
        ) : null}
      </div>
      <div className="p-span-4 p-stack">
        <Panel title="On-chain balance" note={wallet.updatedAt ? 'Checks every 5 seconds' : undefined}>
          {wallet.loading && !wallet.data ? (
            <Skeleton height={90} />
          ) : wallet.error && !wallet.data ? (
            <Notice tone="danger" title="Couldn't load the wallet balance" action={<button type="button" className="p-btn p-btn-sm" onClick={() => void wallet.reload()}>Retry</button>}>
              {wallet.error}
            </Notice>
          ) : (
            <div className="p-stack">
              <div data-testid="balance-total">
                <Stat label="Total on-chain">
                  <Amount sats={wallet.data?.totalSat} />
                </Stat>
              </div>
              <Details
                rows={[
                  { label: 'Confirmed', value: <span data-testid="balance-confirmed"><Amount sats={wallet.data?.confirmedSat} /></span> },
                  { label: 'Unconfirmed (incoming)', value: <Amount sats={wallet.data?.unconfirmedSat} /> },
                ]}
              />
              {incoming ? (
                <Notice tone="info" title="Deposit incoming">
                  <Amount sats={unconfNow - Number(base?.unconfirmedSat ?? 0)} /> is waiting for its first confirmation.
                </Notice>
              ) : confirmedUp ? (
                <Notice tone="positive" title="Deposit confirmed">
                  Your confirmed balance is up <Amount sats={confNow - Number(base?.confirmedSat ?? 0)} /> since this address was created.
                </Notice>
              ) : null}
            </div>
          )}
        </Panel>
        <Panel title="What happens next">
          <Timeline items={steps} />
        </Panel>
      </div>
    </div>
  );
}

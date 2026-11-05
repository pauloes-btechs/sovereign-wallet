/**
 * Wallet screens: Home (balances + VTXO lifecycle), Send (quote → confirm →
 * reconcile), Receive (on-chain boarding + swap-based Lightning), and the
 * Capabilities disclosure screen. Everything shown is derived from live
 * controller state and provider-declared capabilities — no hardcoded parity.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  describeDependencyKind,
  describeRequiredFor,
  describeSeedType,
  describeUnilateralExit,
  mechanismLabel,
  satsLabel,
  vtxoStateLabel,
} from '@sovereign/ui/copy';
import type { TransactionRecord } from '@sovereign/wallet-core';
import type { ModeAController, ModeAState } from '../flows/modeAController.js';
import {
  MobileBadge,
  MobileBalanceGrid,
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileFlowTabs,
  MobileHeader,
  MobileLabelRow,
  MobileNavRow,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles as baseStyles,
  utcClock,
} from './Primitives.js';

// ——— Home ———

/** The everyday wallet: three buckets, one VTXO lifecycle notice, two actions. */
export function HomeScreen({
  controller,
  state,
  network,
}: {
  controller: ModeAController;
  state: ModeAState;
  network: string;
}): ReactNode {
  const { balances, vtxo } = state;
  const capabilities = controller.capabilities;
  const operator =
    vtxo === null
      ? 'checking Ark operator'
      : vtxo.operatorReachable
        ? 'Ark operator reachable'
        : 'Ark operator unreachable';

  return (
    <MobileScreen>
      <MobileHeader title="Wallet" subtitle={`${network} · ${operator}`} />
      {balances !== null ? (
        <MobileBalanceGrid buckets={balances} />
      ) : state.balancesError !== null ? (
        <MobileWarningBand tone="danger">
          <Text style={styles.bandText}>Balances could not be read: {state.balancesError}</Text>
        </MobileWarningBand>
      ) : (
        <Text style={styles.dim}>Loading balances…</Text>
      )}

      <BalanceFreshness
        updatedAt={state.balancesUpdatedAt}
        error={balances !== null ? state.balancesError : null}
        refreshing={state.balancesRefreshing}
        onRefresh={() => void controller.refreshBalances()}
      />

      {vtxo !== null && (
        <VtxoNotice
          state={vtxo.state}
          operatorReachable={vtxo.operatorReachable}
          hoursToExpiry={vtxo.hoursToExpiry}
          unilateralExit={capabilities.unilateralExit}
        />
      )}

      <MobileButtonGroup row>
        <MobileButton label="Send" onPress={() => controller.navigate('send')} />
        <MobileButton label="Receive" onPress={() => controller.navigate('receive')} />
      </MobileButtonGroup>
      <MobileNavRow
        label="How this wallet works"
        detail="Lightning mechanism, exits, recovery and the services this wallet depends on"
        onPress={() => controller.navigate('capabilities')}
      />
    </MobileScreen>
  );
}

/**
 * When the numbers above were read — from the controller's last successful
 * refresh, never the render clock — plus a manual refresh.
 */
function BalanceFreshness({
  updatedAt,
  error,
  refreshing,
  onRefresh,
}: {
  updatedAt: number | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}): ReactNode {
  return (
    <View style={styles.rowBetween}>
      <View style={styles.flexShrink}>
        <Text style={styles.faint}>
          {refreshing
            ? 'Refreshing…'
            : updatedAt !== null
              ? `Updated ${utcClock(updatedAt)}`
              : 'Not read yet'}
        </Text>
        {error !== null && (
          <Text style={[styles.faint, { color: mobilePalette.danger }]} accessibilityRole="alert">
            Last refresh failed: {error}
          </Text>
        )}
      </View>
      <MobileButton label="Refresh" kind="ghost" compact busy={refreshing} onPress={onRefresh} />
    </View>
  );
}

// ——— Activity ———

const KIND_LABEL: Record<TransactionRecord['kind'], string> = {
  'lightning-invoice': 'Lightning',
  onchain: 'On-chain',
  'ark-vtxo': 'Ark',
  'asset-transfer': 'Asset',
};

const STATUS_BADGE: Record<TransactionRecord['status'], { label: string; tone: 'positive' | 'warning' | 'danger' }> = {
  settled: { label: 'Settled', tone: 'positive' },
  pending: { label: 'Pending', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** "2026-10-30 14:02 UTC", or the raw value when the daemon sent something unparseable. */
function activityTime(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function shortRef(ref: string): string {
  return ref.length > 18 ? `${ref.slice(0, 8)}…${ref.slice(-6)}` : ref;
}

/** One page of the wallet's activity stream, exactly as the daemon reports it. */
export function ActivityScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const { activity, activityStatus, activityError } = state;
  return (
    <MobileScreen>
      <View style={styles.rowBetween}>
        <View style={styles.flexShrink}>
          <MobileHeader title="Activity" subtitle="Payments recorded by this wallet" />
        </View>
        <MobileButton
          label="Refresh"
          kind="ghost"
          compact
          busy={activityStatus === 'loading'}
          onPress={() => void controller.loadActivity()}
        />
      </View>

      {activityStatus === 'failed' && (
        <MobileWarningBand tone="danger">
          <Text style={styles.bandText}>Activity could not be read: {activityError}</Text>
        </MobileWarningBand>
      )}
      {activity === null && activityStatus !== 'failed' && (
        <Text style={styles.dim}>Loading activity…</Text>
      )}
      {activity !== null && activity.length === 0 && (
        <MobilePanel>
          <Text style={styles.dim}>
            No activity yet. Payments you send or receive appear here once the wallet records
            them.
          </Text>
        </MobilePanel>
      )}
      {activity !== null && activity.length > 0 && (
        <MobilePanel>
          {activity.map((record, index) => {
            const badge = STATUS_BADGE[record.status];
            return (
              <View
                key={`${record.txId}-${index}`}
                style={[styles.activityRow, index > 0 ? styles.activityRowDivider : null]}
              >
                <View style={styles.flexShrink}>
                  <Text style={styles.value}>
                    {record.direction === 'out' ? 'Sent' : 'Received'} · {KIND_LABEL[record.kind]}
                  </Text>
                  {record.at !== '' && <Text style={styles.faint}>{activityTime(record.at)}</Text>}
                  <Text style={[styles.faint, styles.mono]}>{shortRef(record.txId)}</Text>
                </View>
                <View style={styles.activityAmount}>
                  <Text style={styles.value}>
                    {record.amountSat === 0n ? '' : record.direction === 'out' ? '−' : '+'}
                    {satsLabel(record.amountSat)}
                  </Text>
                  <MobileBadge label={badge.label} tone={badge.tone} />
                </View>
              </View>
            );
          })}
        </MobilePanel>
      )}
    </MobileScreen>
  );
}

/**
 * The spec's VTXO lifecycle as a user-visible band: fresh is quiet; expiring
 * reassures; exiting explains; at-risk discloses the unilateral exit path.
 */
function VtxoNotice({
  state,
  operatorReachable,
  hoursToExpiry,
  unilateralExit,
}: {
  state: ModeAState['vtxo'] extends null ? never : NonNullable<ModeAState['vtxo']>['state'];
  operatorReachable: boolean;
  hoursToExpiry: number | null;
  unilateralExit: 'unsupported' | 'async' | 'instant';
}): ReactNode {
  if (state === 'fresh') return null;
  if (state === 'expiring') {
    return (
      <MobileWarningBand tone="warning">
        <Text style={styles.h3}>{vtxoStateLabel(state)}</Text>
        <Text style={styles.dim}>
          Your funds are being rolled forward automatically
          {hoursToExpiry !== null ? ` — next deadline in about ${hoursToExpiry} hour${hoursToExpiry === 1 ? '' : 's'}` : ''}.
        </Text>
      </MobileWarningBand>
    );
  }
  if (state === 'exiting') {
    return (
      <MobileWarningBand tone="info">
        <Text style={styles.h3}>{vtxoStateLabel(state)}</Text>
        <Text style={styles.dim}>
          These funds are moving to the on-chain balance and will be spendable there. This cannot
          be cancelled.
        </Text>
      </MobileWarningBand>
    );
  }
  return (
    <MobileWarningBand tone="danger">
      <Text style={styles.h3}>{vtxoStateLabel(state)}</Text>
      <Text style={styles.dim}>
        {operatorReachable
          ? 'Some funds could not be refreshed in time. They will exit to the on-chain balance.'
          : 'The swap operator is unreachable, so cooperative payments are paused. Your funds will exit to the on-chain balance without the operator.'}
        {unilateralExit !== 'unsupported' && describeUnilateralExit(unilateralExit) !== ''
          ? ` ${describeUnilateralExit(unilateralExit)}`
          : ''}
      </Text>
    </MobileWarningBand>
  );
}

// ——— Send ———

/** Send flow: draft → live quote (fee shown) → confirm → settle/reconcile. */
export function SendScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const capabilities = controller.capabilities;
  const amountReady = state.sendKind === 'lightning' || /^\d+$/.test(state.sendAmountText.trim());
  const destinationReady = state.sendDestination.trim().length > 0;
  const reviewBlocker = !destinationReady
    ? state.sendKind === 'lightning'
      ? 'Paste an invoice to review the payment.'
      : 'Paste an address to review the payment.'
    : !amountReady
      ? 'Enter a whole number of sats to review the payment.'
      : null;

  return (
    <MobileScreen>
      <MobileHeader title="Pay" />
      <PaySwitch controller={controller} active="send" />
      {state.sendStatus === 'idle' ? (
        // The rail is chosen while drafting; once quoted it is fixed for this payment.
        <MobileFlowTabs
          tabs={[
            { id: 'lightning', label: 'Lightning' },
            { id: 'onchain', label: 'On-chain' },
          ]}
          activeId={state.sendKind}
          onChange={(id) => controller.setSendKind(id === 'onchain' ? 'onchain' : 'lightning')}
          variant="underline"
        />
      ) : (
        <Text style={styles.overline}>
          {state.sendKind === 'lightning' ? 'Lightning payment' : 'On-chain payment'}
        </Text>
      )}
      {state.sendKind === 'lightning' && (
        <Text style={styles.faint}>{mechanismLabel(capabilities.lightningMechanism)}.</Text>
      )}

      {state.sendStatus === 'idle' && (
        <>
          <MobileField
            label={state.sendKind === 'lightning' ? 'Lightning invoice' : 'Recipient address'}
            value={state.sendDestination}
            onChangeText={(text) => controller.setSendDestination(text)}
            placeholder={
              state.sendKind === 'lightning' ? 'Paste a Lightning invoice' : 'Paste a Bitcoin address'
            }
            multiline={state.sendKind === 'lightning'}
          />
          {state.sendKind === 'onchain' && (
            <MobileField
              label="Amount (sats)"
              value={state.sendAmountText}
              onChangeText={(text) => controller.setSendAmount(text)}
              placeholder="Amount in sats"
            />
          )}
          <MobileErrorNote error={state.sendError} />
          <MobileButton
            label="Review payment"
            onPress={() => void controller.reviewSend()}
            disabled={reviewBlocker !== null}
            busy={state.busy}
          />
          {reviewBlocker !== null && <Text style={styles.faint}>{reviewBlocker}</Text>}
        </>
      )}

      {state.sendStatus === 'review' && (
        <>
          <MobilePanel title="Review">
            <MobileLabelRow
              label="To"
              value={
                state.sendDestination.length > 24
                  ? `${state.sendDestination.slice(0, 24)}…`
                  : state.sendDestination
              }
            />
            {state.sendAmountSat !== null && (
              <MobileLabelRow label="Amount" value={satsLabel(state.sendAmountSat)} mono={false} />
            )}
            {state.sendFeeSat !== null && (
              <MobileLabelRow label="Service fee" value={satsLabel(state.sendFeeSat)} mono={false} />
            )}
          </MobilePanel>
          {state.sendKind === 'lightning' && (
            <Text style={styles.faint}>
              {mechanismLabel(capabilities.lightningMechanism)} — the swap service routes this
              payment; its fee is shown above.
            </Text>
          )}
          <MobileButtonGroup>
            <MobileButton
              label="Confirm and send"
              onPress={() => void controller.confirmSend()}
              busy={state.busy}
            />
            <MobileButton
              label="Back to edit"
              kind="secondary"
              onPress={controller.sendAnother}
            />
          </MobileButtonGroup>
        </>
      )}

      {state.sendStatus === 'sending' && (
        <>
          <MobileWarningBand tone="warning">
            <Text style={styles.bandText}>Payment in flight — do not close the app.</Text>
            <Text style={styles.dim}>
              The result was not final when the wallet answered. Check its status before trying
              again — paying twice is the risk of retrying blind.
            </Text>
          </MobileWarningBand>
          <MobileButton
            label="Check payment status"
            onPress={() => void controller.reconcilePending()}
          />
        </>
      )}

      {state.sendStatus === 'settled' && (
        <>
          <MobileWarningBand tone="positive">
            <Text style={styles.bandText}>Payment sent.</Text>
          </MobileWarningBand>
          <MobileButtonGroup>
            <MobileButton label="Send another payment" onPress={controller.sendAnother} />
            <MobileButton label="Done" kind="secondary" onPress={controller.backToHome} />
          </MobileButtonGroup>
        </>
      )}

      {state.sendStatus === 'failed' && (
        <>
          <MobileErrorNote error={state.sendError ?? 'The payment failed.'} />
          <MobileButtonGroup>
            <MobileButton label="Start over" onPress={controller.sendAnother} />
            <MobileButton label="Done" kind="secondary" onPress={controller.backToHome} />
          </MobileButtonGroup>
        </>
      )}
    </MobileScreen>
  );
}

// ——— Receive ———

/** Receive flow: on-chain boarding address or a swap-based Lightning invoice. */
export function ReceiveScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const capabilities = controller.capabilities;
  const amountReady = /^\d+$/.test(state.receiveAmountText.trim());

  return (
    <MobileScreen>
      <MobileHeader title="Pay" />
      <PaySwitch controller={controller} active="receive" />
      <MobileFlowTabs
        tabs={[
          { id: 'onchain', label: 'On-chain' },
          { id: 'lightning', label: 'Lightning' },
        ]}
        activeId={state.receiveTab}
        onChange={(id) => controller.setReceiveTab(id === 'lightning' ? 'lightning' : 'onchain')}
        variant="underline"
      />

      {state.receiveTab === 'onchain' && (
        <>
          <Text style={styles.dim}>
            Deposit Bitcoin on-chain into your wallet. A fresh address is generated each time.
          </Text>
          <MobileButton
            label="Generate address"
            onPress={() => void controller.generateAddress().catch(() => undefined)}
            busy={state.busy}
          />
          <MobileErrorNote error={state.receiveError} />
          {state.onchainAddress !== null && (
            <MobilePanel>
              <MobileLabelRow label="Your address" value={state.onchainAddress} />
            </MobilePanel>
          )}
        </>
      )}

      {state.receiveTab === 'lightning' && (
        <>
          <Text style={styles.dim}>
            {mechanismLabel(capabilities.lightningMechanism)} — this invoice is paid through the
            swap service, so include the amount you want to receive.
          </Text>
          <MobileField
            label="Amount (sats)"
            value={state.receiveAmountText}
            onChangeText={(text) => controller.setReceiveAmount(text)}
            placeholder="Amount in sats"
          />
          <MobileButton
            label="New invoice"
            onPress={() => void controller.generateInvoice().catch(() => undefined)}
            disabled={!amountReady}
            busy={state.busy}
          />
          {!amountReady && (
            <Text style={styles.faint}>Enter a whole number of sats to create an invoice.</Text>
          )}
          <MobileErrorNote error={state.receiveError} />
          {state.invoice !== null && (
            <MobilePanel>
              <MobileLabelRow label="Your invoice" value={state.invoice} />
            </MobilePanel>
          )}
        </>
      )}
    </MobileScreen>
  );
}

// ——— Capabilities ———

/**
 * The "How this wallet works" screen — every row is rendered from the
 * provider's DECLARED capabilities and operator dependencies (disclosures
 * verbatim), never from hardcoded feature claims.
 */
export function CapabilitiesScreen({
  controller,
}: {
  controller: ModeAController;
}): ReactNode {
  const capabilities = controller.capabilities;
  return (
    <MobileScreen>
      <MobileHeader title="How this wallet works" onBack={() => controller.navigate('more')} />
      <MobilePanel>
        <MobileLabelRow
          label="Lightning"
          value={mechanismLabel(capabilities.lightningMechanism)}
          mono={false}
        />
        <MobileLabelRow
          label="Unilateral exit"
          value={describeUnilateralExit(capabilities.unilateralExit)}
          mono={false}
        />
        <MobileLabelRow
          label="Recovery"
          value={describeSeedType(capabilities.recoveryModel)}
          mono={false}
        />
      </MobilePanel>
      <Text style={styles.h3}>Services this wallet depends on</Text>
      {capabilities.operatorDependencies.length === 0 ? (
        <Text style={styles.dim}>No service dependencies beyond the Bitcoin network itself.</Text>
      ) : (
        capabilities.operatorDependencies.map((dependency) => (
          <MobileWarningBand key={dependency.kind} tone="warning">
            <Text style={styles.h3}>{describeDependencyKind(dependency.kind)}</Text>
            <Text style={styles.dim}>{dependency.disclosure}</Text>
            <Text style={styles.faint}>
              Required for: {dependency.requiredFor.map((use) => describeRequiredFor(use)).join(', ')}
            </Text>
          </MobileWarningBand>
        ))
      )}
      <Text style={styles.faint}>
        Accepted recovery phrases:{' '}
        {controller.seedCompatibility
          .map((seed) =>
            seed === capabilities.recoveryModel ? describeSeedType(capabilities.recoveryModel) : seed,
          )
          .join(', ')}{' '}
        — phrases from other wallet apps are refused rather than partially restored.
      </Text>
    </MobileScreen>
  );
}

// ——— Pay switch ———

/** Send / Receive under the Pay tab — both flows keep their own drafts. */
function PaySwitch({
  controller,
  active,
}: {
  controller: ModeAController;
  active: 'send' | 'receive';
}): ReactNode {
  return (
    <MobileFlowTabs
      tabs={[
        { id: 'send', label: 'Send' },
        { id: 'receive', label: 'Receive' },
      ]}
      activeId={active}
      onChange={(id) => controller.navigate(id === 'receive' ? 'receive' : 'send')}
    />
  );
}

// ——— More ———

/**
 * Wallet status and reference. Every value is read from the controller; the
 * modes this build does not run say so instead of offering dead controls.
 */
export function MoreScreen({
  controller,
  state,
  network,
}: {
  controller: ModeAController;
  state: ModeAState;
  network: string;
}): ReactNode {
  const vtxo = state.vtxo;
  return (
    <MobileScreen>
      <MobileHeader title="More" />
      <MobilePanel title="This wallet">
        <MobileLabelRow label="Mode" value="Everyday (Wavelength)" mono={false} />
        <MobileLabelRow label="Network" value={network} mono={false} />
        <MobileLabelRow
          label="Ark operator"
          value={vtxo === null ? 'Not checked yet' : vtxo.operatorReachable ? 'Reachable' : 'Unreachable'}
          mono={false}
        />
        <MobileLabelRow
          label="Balances read"
          value={state.balancesUpdatedAt === null ? 'Not read yet' : utcClock(state.balancesUpdatedAt)}
          mono={false}
        />
      </MobilePanel>
      <MobileNavRow
        label="How this wallet works"
        detail="Lightning mechanism, exits, recovery and service dependencies"
        onPress={() => controller.navigate('capabilities')}
      />
      <MobilePanel title="Not in this build">
        <Text style={styles.dim}>
          Channels, liquidity (Loop, Pool) and Taproot Assets need your own Lightning node, and
          are managed from the desktop app. This everyday wallet has no channels to manage.
        </Text>
        <Text style={styles.dim}>
          Starting a unilateral exit from this screen is not available yet; the exit path is
          described under How this wallet works.
        </Text>
      </MobilePanel>
    </MobileScreen>
  );
}

const styles = {
  ...baseStyles,
  ...StyleSheet.create({
    flexShrink: { flexShrink: 1 },
    activityRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      paddingVertical: 10,
    },
    activityRowDivider: { borderTopWidth: 1, borderTopColor: mobilePalette.border },
    activityAmount: { alignItems: 'flex-end', gap: 4 },
  }),
};

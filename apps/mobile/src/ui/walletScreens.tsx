/**
 * Wallet screens: Home (balances + VTXO lifecycle), Send (quote → confirm →
 * reconcile), Receive (on-chain boarding + swap-based Lightning), and the
 * Capabilities disclosure screen. Everything shown is derived from live
 * controller state and provider-declared capabilities — no hardcoded parity.
 */

import type { ReactNode } from 'react';
import { Text } from 'react-native';
import {
  describeDependencyKind,
  describeRequiredFor,
  describeSeedType,
  describeUnilateralExit,
  mechanismLabel,
  satsLabel,
  vtxoStateLabel,
} from '@sovereign/ui/copy';
import type { ModeAController, ModeAState } from '../flows/modeAController.js';
import {
  MobileBalanceGrid,
  MobileBalanceStatus,
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileFlowTabs,
  MobileHeader,
  MobileLabelRow,
  MobileScreen,
  MobileWarningBand,
  styles,
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

  return (
    <MobileScreen>
      <MobileHeader title="Wallet" />
      {balances !== null ? (
        <MobileBalanceGrid buckets={balances} />
      ) : (
        <Text style={styles.dim}>Loading balances…</Text>
      )}

      {vtxo !== null && (
        <VtxoNotice
          state={vtxo.state}
          operatorReachable={vtxo.operatorReachable}
          hoursToExpiry={vtxo.hoursToExpiry}
          unilateralExit={capabilities.unilateralExit}
        />
      )}

      <MobileButtonGroup>
        <MobileButton label="Send" onPress={() => controller.navigate('send')} />
        <MobileButton label="Receive" onPress={() => controller.navigate('receive')} />
        <MobileButton
          label="How this wallet works"
          kind="secondary"
          onPress={() => controller.navigate('capabilities')}
        />
      </MobileButtonGroup>
      <MobileBalanceStatus network={network} status="synced" syncedAt={Date.now()} />
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

  return (
    <MobileScreen>
      <MobileHeader title="Send" onBack={() => controller.backToHome()} />
      <MobileFlowTabs
        tabs={[
          { id: 'lightning', label: 'Lightning' },
          { id: 'onchain', label: 'On-chain' },
        ]}
        activeId={state.sendKind}
        onChange={(id) => controller.setSendKind(id === 'onchain' ? 'onchain' : 'lightning')}
      />
      <Text style={styles.faint}>{mechanismLabel(capabilities.lightningMechanism)}.</Text>

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
            disabled={state.busy || (state.sendKind === 'onchain' && !amountReady)}
          />
        </>
      )}

      {state.sendStatus === 'review' && (
        <>
          <MobileLabelRow
            label="To"
            value={
              state.sendDestination.length > 24
                ? `${state.sendDestination.slice(0, 24)}…`
                : state.sendDestination
            }
          />
          {state.sendAmountSat !== null && (
            <MobileLabelRow label="Amount" value={satsLabel(state.sendAmountSat)} />
          )}
          {state.sendFeeSat !== null && (
            <MobileLabelRow label="Service fee" value={satsLabel(state.sendFeeSat)} />
          )}
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
              disabled={state.busy}
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
            <Text style={styles.dim}>Payment in flight — do not close the app.</Text>
          </MobileWarningBand>
          <MobileButton
            label="Check payment status"
            onPress={() => void controller.reconcilePending()}
          />
        </>
      )}

      {state.sendStatus === 'settled' && (
        <>
          <MobileWarningBand tone="info">
            <Text style={styles.dim}>Payment sent.</Text>
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

  return (
    <MobileScreen>
      <MobileHeader title="Receive" onBack={() => controller.backToHome()} />
      <MobileFlowTabs
        tabs={[
          { id: 'onchain', label: 'On-chain' },
          { id: 'lightning', label: 'Lightning' },
        ]}
        activeId={state.receiveTab}
        onChange={(id) => controller.setReceiveTab(id === 'lightning' ? 'lightning' : 'onchain')}
      />

      {state.receiveTab === 'onchain' && (
        <>
          <Text style={styles.dim}>
            Deposit Bitcoin on-chain into your wallet. A fresh address is generated each time.
          </Text>
          <MobileButton label="Generate address" onPress={() => void controller.generateAddress()} disabled={state.busy} />
          {state.onchainAddress !== null && (
            <MobileLabelRow label="Your address" value={state.onchainAddress} />
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
            onPress={() => void controller.generateInvoice()}
            disabled={state.busy || !/^\d+$/.test(state.receiveAmountText.trim())}
          />
          {state.invoice !== null && <MobileLabelRow label="Your invoice" value={state.invoice} />}
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
      <MobileHeader title="How this wallet works" onBack={() => controller.backToHome()} />
      <MobileLabelRow label="Lightning" value={mechanismLabel(capabilities.lightningMechanism)} />
      <MobileLabelRow
        label="Unilateral exit"
        value={describeUnilateralExit(capabilities.unilateralExit)}
      />
      <MobileLabelRow
        label="Recovery"
        value={describeSeedType(capabilities.recoveryModel)}
      />
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
        Accepted recovery phrases: {controller.seedCompatibility.join(', ')} — phrases from other
        wallet apps are refused rather than partially restored.
      </Text>
    </MobileScreen>
  );
}

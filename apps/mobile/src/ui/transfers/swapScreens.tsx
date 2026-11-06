/**
 * Loop swaps on a remote node (Mode B): the swap flow (amount → real quote →
 * review → device authorization → start), live progress with receipt or
 * actionable failure, and swap history. Presentation only — the rules live
 * in `RemoteSwapStore` (flows/transfers.ts).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  MobileAmount,
  MobileBadge,
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileHeader,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  styles,
} from '../Primitives.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../../flows/modeBRemoteController.js';
import type { ChannelLiquidity } from '../../flows/liquidity.js';
import type { LoopDirection, RemoteSwap, SwapDraft, SwapFunds } from '../../flows/transfers.js';
import {
  DIRECTION_LABEL,
  SWAP_STATE_LABEL,
  explainSwapFailure,
  groupSats,
  isTerminal,
  pendingExplanation,
  swapProgress,
  totalCostSat,
  worstCaseFeeSat,
} from '../../flows/transfers.js';
import { useDeviceAuthorization } from './authorize.js';
import { AmountFact, Bullets, CopyableId, Divider, Fact, SimulatedBanner, StepList, local, utcTime } from './parts.js';

/** Funds the swap checks use: channel liquidity (reserves applied when known) and on-chain. */
export function useRemoteFunds(
  controller: ModeBRemoteController,
  state: ModeBRemoteState,
): { readonly funds: SwapFunds | null; readonly liquidity: ChannelLiquidity | null } {
  useSyncExternalStore(controller.channels.subscribe, controller.channels.getState);
  const liquidity = controller.channels.liquidity(state.balances);
  if (state.balances === null || liquidity === null) return { funds: null, liquidity };
  return {
    funds: {
      lightningSpendableSat: liquidity.spendableSat,
      onchainSat: state.balances.onchainConfirmedSat,
      receivableSat: liquidity.receivableSat,
    },
    liquidity,
  };
}

const FLOW_STEPS = ['Amount', 'Review', 'Progress'] as const;

function FlowSteps({ current }: { current: 0 | 1 | 2 }): ReactNode {
  return (
    <View style={styles.rowStart} accessibilityLabel={`Step ${current + 1} of 3: ${FLOW_STEPS[current]}`}>
      {FLOW_STEPS.map((label, i) => (
        <Text key={label} style={[styles.faint, i === current ? local.strong : null]}>
          {i > 0 ? '·  ' : ''}
          {i + 1}. {label}
        </Text>
      ))}
    </View>
  );
}

export function SwapFlowScreen({
  controller,
  state,
  direction,
  amountParam,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
  direction: LoopDirection;
  amountParam: string | null;
}): ReactNode {
  const swaps = useSyncExternalStore(controller.swaps.subscribe, controller.swaps.getState);
  const { funds } = useRemoteFunds(controller, state);
  const caps = controller.walletCapabilities().features.loopSwaps;
  const draft = swaps.draft;

  useEffect(() => {
    // A fresh draft for this direction (prefilled from a recommendation when given).
    const current = controller.swaps.getState().draft;
    if (current === null || current.direction !== direction) {
      controller.swaps.beginDraft(direction, amountParam !== null && /^\d+$/.test(amountParam) ? BigInt(amountParam) : undefined);
    }
    if (controller.channels.getState().status === 'idle') void controller.channels.load();
  }, [controller, direction, amountParam]);

  const out = direction === 'loop-out';
  const label = DIRECTION_LABEL[direction];
  const range = swaps.terms === null ? null : out ? swaps.terms.loopOut : swaps.terms.loopIn;
  const simulated = controller.isSimulated();

  if (!caps.available) {
    return (
      <MobileScreen>
        <MobileHeader title={label} onBack={() => controller.goBack()} />
        <MobileWarningBand tone="warning">{caps.reason}</MobileWarningBand>
      </MobileScreen>
    );
  }
  if (draft === null) {
    return (
      <MobileScreen>
        <MobileHeader title={label} onBack={() => controller.goBack()} />
        <Text style={styles.dim}>Preparing…</Text>
      </MobileScreen>
    );
  }

  if (draft.stage === 'uncertain') {
    return <UncertainStart controller={controller} />;
  }

  const reviewing = draft.stage === 'review' || draft.stage === 'confirming';
  return (
    <MobileScreen>
      <MobileHeader
        title={label}
        subtitle={out ? 'Lightning balance to on-chain bitcoin' : 'On-chain bitcoin to Lightning balance'}
        onBack={() => {
          if (reviewing && draft.stage !== 'confirming') controller.swaps.backToEdit();
          else controller.goBack();
        }}
      />
      <FlowSteps current={reviewing ? 1 : 0} />
      <SimulatedBanner show={simulated} what="the swap server's terms, quotes and swaps" />
      {!reviewing ? (
        <>
          <MobilePanel title="From">
            {funds === null ? (
              <Text style={styles.dim}>Reading balances…</Text>
            ) : out ? (
              <AmountFact label="Lightning balance you can send" sats={funds.lightningSpendableSat} />
            ) : (
              <AmountFact label="Confirmed on-chain" sats={funds.onchainSat} />
            )}
          </MobilePanel>
          <MobilePanel title="To">
            {out ? (
              <MobileField
                label="Bitcoin address (optional)"
                value={draft.destinationText}
                onChangeText={(t) => controller.swaps.editDestination(t)}
                placeholder="Leave empty for your node's wallet"
                hint="Empty: a fresh address in your node's own wallet."
              />
            ) : funds !== null ? (
              <AmountFact label="Your channels can receive" sats={funds.receivableSat} />
            ) : null}
          </MobilePanel>
          <MobileField
            label="Amount (sats)"
            value={draft.amountText}
            onChangeText={(t) => controller.swaps.editAmount(t)}
            placeholder={range === null ? '250000' : range.minSat.toString()}
            hint={
              swaps.termsStatus === 'loaded' && range !== null
                ? `Swap server limits: ${groupSats(range.minSat)} to ${groupSats(range.maxSat)} sats.`
                : swaps.termsStatus === 'failed'
                  ? `The swap server's limits could not be read: ${swaps.termsError ?? 'unknown error'}`
                  : "Reading the swap server's limits…"
            }
          />
          <MobileErrorNote error={draft.error} />
          <MobileButton
            label={draft.stage === 'quoting' ? 'Getting a quote…' : 'Get quote'}
            busy={draft.stage === 'quoting'}
            disabled={funds === null || swaps.termsStatus !== 'loaded'}
            onPress={() => {
              if (funds !== null) void controller.swaps.review(funds);
            }}
          />
          <Text style={styles.faint}>
            {out
              ? 'A Loop Out moves Lightning balance on-chain and frees the same room to receive.'
              : 'A Loop In moves on-chain funds into your channels so you can send more.'}
          </Text>
        </>
      ) : draft.quote !== null ? (
        <SwapReview
          controller={controller}
          direction={direction}
          stage={draft.stage}
          error={draft.error}
          destination={draft.destinationText}
        />
      ) : null}
    </MobileScreen>
  );
}

/** A start whose reply was lost: the swap may exist. Nothing else starts until it is checked. */
function UncertainStart({ controller }: { controller: ModeBRemoteController }): ReactNode {
  const swaps = useSyncExternalStore(controller.swaps.subscribe, controller.swaps.getState);
  const [checking, setChecking] = useState(false);
  const draft = swaps.draft;
  const pending = draft?.pendingStart ?? null;
  if (draft === null || pending === null) return null;
  const label = DIRECTION_LABEL[pending.direction];
  return (
    <MobileScreen>
      <MobileHeader title={label} onBack={() => controller.goBack()} />
      <MobileWarningBand tone="warning">
        <Text style={styles.h3}>The {label} may have started</Text>
        <Text style={styles.dim}>{draft.error}</Text>
      </MobileWarningBand>
      <MobilePanel title="What was sent to your node">
        <AmountFact label="Amount" sats={pending.amountSat} />
        <Fact label="Label">{pending.label}</Fact>
      </MobilePanel>
      <Text style={styles.faint}>
        Starting another swap stays blocked until this one is found in your node&apos;s swap list or the list shows it
        isn&apos;t there.
      </Text>
      <MobileButtonGroup>
        <MobileButton
          label="Check my swaps"
          busy={checking}
          onPress={() => {
            setChecking(true);
            void controller.swaps.checkUncertainStart().then((id) => {
              setChecking(false);
              if (id !== null) {
                controller.goBack();
                controller.navigate('swap', { id });
              }
            });
          }}
        />
        <MobileButton label="Back" kind="ghost" disabled={checking} onPress={() => controller.goBack()} />
      </MobileButtonGroup>
    </MobileScreen>
  );
}

function SwapReview({
  controller,
  direction,
  stage,
  error,
  destination,
}: {
  controller: ModeBRemoteController;
  direction: LoopDirection;
  stage: SwapDraft['stage'];
  error: string | null;
  destination: string;
}): ReactNode {
  const swaps = useSyncExternalStore(controller.swaps.subscribe, controller.swaps.getState);
  const auth = useDeviceAuthorization();
  const [authNote, setAuthNote] = useState<string | null>(null);
  const q = swaps.draft?.quote;
  if (q === null || q === undefined) return null;
  const out = direction === 'loop-out';
  const label = DIRECTION_LABEL[direction];
  const confirming = stage === 'confirming';
  const worst = worstCaseFeeSat({
    direction,
    amountSat: q.amountSat,
    swapFeeSat: q.swapFeeSat,
    prepayAmtSat: q.prepayAmtSat,
    minerFeeSat: q.minerFeeSat,
    confTarget: q.confTarget,
    cltvDelta: q.cltvDelta,
  });
  return (
    <>
      <MobilePanel title="Review">
        <Fact label="From">{out ? 'Lightning balance' : 'On-chain (node wallet)'}</Fact>
        <Fact label="To">
          {out
            ? destination.trim() === ''
              ? "A new address in your node's wallet"
              : destination.trim()
            : 'Lightning balance'}
        </Fact>
        <AmountFact label="Amount" sats={q.amountSat} strong />
        <Divider />
        <AmountFact
          label="Swap fee"
          sats={q.swapFeeSat}
          note={`${q.swapFeePpm.toLocaleString('en-US')} ppm, charged by the swap server.`}
        />
        {out && (
          <AmountFact
            label="Of which paid up front"
            sats={q.prepayAmtSat}
            note="Part of the swap fee above, not added to it. Kept by the server if the swap is abandoned."
          />
        )}
        <AmountFact
          label={out ? 'Miner fee (your claim)' : 'Miner fee (your contract)'}
          sats={q.minerFeeSat}
          note={`Estimate for a ${q.confTarget}-block target.`}
        />
        <AmountFact
          label={out ? 'Lightning routing fee, at most' : 'Lightning routing fee'}
          sats={q.routingFeeCapSat}
          note={out ? "Loop's default cap: 10 sats + 2% of the swap and prepayment. Usually far less is used." : 'None: the server pays you.'}
        />
        <Divider />
        <AmountFact label="Total fees you approve" sats={q.totalFeeSat} strong />
        <AmountFact
          label={out ? 'Arrives on-chain (estimate)' : 'Arrives as Lightning balance'}
          sats={q.receivedSat}
          strong
        />
      </MobilePanel>
      <MobilePanel title="Limits sent to your node">
        <Text style={styles.faint}>
          If fees rise above the total you approve before the swap starts, it is re-quoted and refused. Once started, your node's Loop
          service will not spend more than these hard limits (the miner-fee limit allows twice the estimate):
        </Text>
        <AmountFact label="Most this swap can cost" sats={worst} />
        <Fact label="Timing">{out ? 'A few blocks' : 'A confirmation or more, then seconds'}</Fact>
        <Bullets
          items={
            out
              ? [
                  'Atomic: your node completes the Lightning payment only once the on-chain contract exists.',
                  'The swap runs on your node; you can close the app once it has started.',
                ]
              : [
                  'If the server never pays, your node takes the funds back after the timeout, minus miner fees.',
                  'The swap runs on your node; you can close the app once it has started.',
                ]
          }
        />
      </MobilePanel>
      <Text style={styles.faint}>
        {controller.swaps.hasDeviceAuthorization() ? 'You will be asked to authorize this on your device.' : auth.description}
      </Text>
      <MobileErrorNote error={error ?? authNote} />
      <MobileButtonGroup>
        <MobileButton
          label={confirming ? `Starting ${label}…` : `Start ${label}`}
          busy={confirming}
          onPress={() => {
            setAuthNote(null);
            void auth.request(`Approve ${label} of ${groupSats(q.amountSat)} sats`).then((ok) => {
              if (!ok) {
                setAuthNote('Not authorized, so the swap did not start.');
                return;
              }
              void controller.swaps.confirm().then((id) => {
                if (id !== null) {
                  controller.goBack();
                  controller.navigate('swap', { id });
                }
              });
            });
          }}
        />
        <MobileButton label="Change amount" kind="ghost" disabled={confirming} onPress={() => controller.swaps.backToEdit()} />
      </MobileButtonGroup>
      {auth.sheet}
    </>
  );
}

const STATE_TONE = (swap: RemoteSwap): 'positive' | 'danger' | 'info' =>
  swap.state === 'succeeded' ? 'positive' : swap.state === 'failed' ? 'danger' : 'info';

export function SwapProgressScreen({
  controller,
  swapId,
}: {
  controller: ModeBRemoteController;
  swapId: string;
}): ReactNode {
  const swaps = useSyncExternalStore(controller.swaps.subscribe, controller.swaps.getState);
  useEffect(() => {
    controller.swaps.watch(swapId);
    return () => controller.swaps.stopWatching();
  }, [controller, swapId]);
  const swap = swaps.watchedId === swapId ? swaps.watched : null;
  const simulated = controller.isSimulated();

  if (swap === null) {
    return (
      <MobileScreen>
        <MobileHeader title="Swap" onBack={() => controller.goBack()} />
        {swaps.watchError !== null ? <MobileErrorNote error={swaps.watchError} /> : <Text style={styles.dim}>Reading the swap from your node…</Text>}
      </MobileScreen>
    );
  }
  const label = DIRECTION_LABEL[swap.direction];
  const failure = swap.state === 'failed' ? explainSwapFailure(swap.direction, swap.failureReason) : null;
  return (
    <MobileScreen>
      <MobileHeader title={label} subtitle={`${groupSats(swap.amountSat)} sats`} onBack={() => controller.goBack()} />
      <SimulatedBanner show={simulated} what="the swap and its progress" />
      <View style={styles.rowBetween}>
        <MobileBadge label={SWAP_STATE_LABEL[swap.state]} tone={STATE_TONE(swap)} />
        <Text style={styles.faint}>Updated {utcTime(swap.updatedAt)}</Text>
      </View>
      {swap.state === 'succeeded' && (
        <MobileWarningBand tone="positive">
          {swap.direction === 'loop-out'
            ? 'Loop Out completed. The funds are on-chain and your channels have more room to receive.'
            : 'Loop In completed. Your Lightning balance increased.'}
        </MobileWarningBand>
      )}
      {failure !== null && (
        <MobileWarningBand tone="danger">
          <Text style={styles.bandText}>{failure.what}</Text>
          <Text style={styles.faint}>{failure.next}</Text>
        </MobileWarningBand>
      )}
      {!isTerminal(swap.state) && <Text style={styles.dim}>{pendingExplanation(swap)}</Text>}
      {swaps.watchError !== null && <MobileErrorNote error={swaps.watchError} />}
      <MobilePanel title="Progress">
        <StepList steps={swapProgress(swap)} />
      </MobilePanel>
      <MobilePanel title={isTerminal(swap.state) ? 'Receipt' : 'So far'}>
        <AmountFact label="Amount" sats={swap.amountSat} />
        <AmountFact label="Swap fee paid" sats={swap.costServerSat} />
        <AmountFact label="On-chain fees paid" sats={swap.costOnchainSat} />
        <AmountFact label="Lightning routing fees paid" sats={swap.costOffchainSat} />
        <Divider />
        <AmountFact label={isTerminal(swap.state) ? 'Total cost' : 'Total cost so far'} sats={totalCostSat(swap)} strong />
        <Fact label="Started">{utcTime(swap.initiatedAt)}</Fact>
        {swap.htlcAddress !== null && <CopyableId label="On-chain contract address" value={swap.htlcAddress} />}
        <CopyableId label="Swap ID" value={swap.id} />
      </MobilePanel>
      {failure !== null && (
        <MobileButton
          label={`Try a new ${label}`}
          kind="secondary"
          onPress={() => {
            controller.swaps.beginDraft(swap.direction);
            controller.navigate('swap-flow', { direction: swap.direction });
          }}
        />
      )}
      <MobileButton label="All swaps" kind="ghost" onPress={() => controller.navigate('swaps')} />
    </MobileScreen>
  );
}

export function SwapHistoryScreen({ controller }: { controller: ModeBRemoteController }): ReactNode {
  const swaps = useSyncExternalStore(controller.swaps.subscribe, controller.swaps.getState);
  useEffect(() => {
    void controller.swaps.loadSwaps();
  }, [controller]);
  const list = swaps.swaps ?? [];
  const pending = list.filter((s) => !isTerminal(s.state));
  const done = list.filter((s) => isTerminal(s.state));
  return (
    <MobileScreen>
      <View style={styles.rowBetween}>
        <View style={local.shrink}>
          <MobileHeader title="Swaps" subtitle="Loop swaps on your node" onBack={() => controller.goBack()} />
        </View>
        <MobileButton label="Refresh" kind="ghost" compact busy={swaps.swapsStatus === 'loading'} onPress={() => void controller.swaps.loadSwaps()} />
      </View>
      <SimulatedBanner show={controller.isSimulated()} what="swaps" />
      {swaps.swapsStatus === 'unavailable' && (
        <MobileWarningBand tone="warning">
          {"Swap history isn't available over this connection. Use the desktop app connected to the same node."}
        </MobileWarningBand>
      )}
      {swaps.swapsStatus === 'failed' && <MobileErrorNote error={`Swaps could not be read: ${swaps.swapsError ?? ''}`} />}
      {swaps.swapsStatus === 'loading' && swaps.swaps === null && <Text style={styles.dim}>Reading swaps…</Text>}
      {swaps.swapsStatus === 'loaded' && list.length === 0 && (
        <MobilePanel>
          <Text style={styles.dim}>No Loop swaps on your node yet.</Text>
        </MobilePanel>
      )}
      {pending.length > 0 && <Text style={styles.overline}>In progress</Text>}
      {pending.map((s) => (
        <SwapRow key={s.id} swap={s} onPress={() => controller.navigate('swap', { id: s.id })} />
      ))}
      {done.length > 0 && <Text style={styles.overline}>Finished</Text>}
      {done.map((s) => (
        <SwapRow key={s.id} swap={s} onPress={() => controller.navigate('swap', { id: s.id })} />
      ))}
    </MobileScreen>
  );
}

function SwapRow({ swap, onPress }: { swap: RemoteSwap; onPress: () => void }): ReactNode {
  const label = DIRECTION_LABEL[swap.direction];
  const failure = swap.state === 'failed' ? explainSwapFailure(swap.direction, swap.failureReason) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${groupSats(swap.amountSat)} sats, ${SWAP_STATE_LABEL[swap.state]}`}
      onPress={onPress}
      style={local.rowCard}
    >
      <View style={styles.rowBetween}>
        <Text style={styles.value}>{label}</Text>
        <MobileAmount sats={swap.amountSat} />
      </View>
      <View style={styles.rowBetween}>
        <Text style={styles.faint}>{utcTime(swap.initiatedAt)}</Text>
        <MobileBadge label={SWAP_STATE_LABEL[swap.state]} tone={STATE_TONE(swap)} />
      </View>
      {failure !== null && <Text style={styles.faint}>{failure.what}</Text>}
      {!isTerminal(swap.state) && <Text style={styles.faint}>Runs on your node; tap to follow its progress.</Text>}
    </Pressable>
  );
}

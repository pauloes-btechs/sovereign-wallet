/**
 * Liquidity awareness. Remote node (Mode B): what you can send and receive,
 * per-channel bars, plain-language warnings and the supported fix (Loop Out
 * for receiving capacity, Loop In for sending capacity), prefilled into the
 * swap flow. Everyday wallet (Mode A): no channels — its real availability
 * (spendable, in flight, on-chain deposits, expiring batches).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import {
  MobileAmount,
  MobileBadge,
  MobileButton,
  MobileField,
  MobileHeader,
  MobileNavRow,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles,
} from '../Primitives.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../../flows/modeBRemoteController.js';
import type { ModeAController, ModeAState } from '../../flows/modeAController.js';
import {
  liquidityAdvice,
  localShare,
  receiveCapacityWarning,
  sendCapacityWarning,
  wavelengthAvailability,
} from '../../flows/liquidity.js';
import { DIRECTION_LABEL, groupSats, isTerminal, parseSwapAmount } from '../../flows/transfers.js';
import { useRemoteFunds } from '../transfers/swapScreens.js';
import { AmountFact, SimulatedBanner, SplitBar, local } from '../transfers/parts.js';

export function RemoteLiquidityScreen({
  controller,
  state,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
}): ReactNode {
  const swaps = useSyncExternalStore(controller.swaps.subscribe, controller.swaps.getState);
  const channelState = useSyncExternalStore(controller.channels.subscribe, controller.channels.getState);
  const { liquidity } = useRemoteFunds(controller, state);
  const loop = controller.walletCapabilities().features.loopSwaps;
  const [checkText, setCheckText] = useState('');

  useEffect(() => {
    void controller.refresh().catch(() => undefined);
    void controller.channels.load();
    if (loop.available) void controller.swaps.loadTerms();
    void controller.swaps.loadSwaps();
  }, [controller, loop.available]);

  const pending = (swaps.swaps ?? []).filter((s) => !isTerminal(s.state));
  const advice =
    liquidity === null || state.balances === null
      ? null
      : liquidityAdvice(liquidity, {
          onchainSat: state.balances.onchainConfirmedSat,
          loopAvailable: loop.available && swaps.termsStatus === 'loaded',
          loopUnavailableReason: loop.available ? (swaps.termsError ?? "Reading the swap server's terms…") : loop.reason,
          terms: swaps.terms,
        });
  const checkAmount = parseSwapAmount(checkText);

  return (
    <MobileScreen>
      <MobileHeader title="Liquidity" subtitle="What your node can send and receive over Lightning" onBack={() => controller.goBack()} />
      <SimulatedBanner show={controller.isSimulated()} what="channels and balances" />
      {liquidity === null ? (
        <Text style={styles.dim}>Reading your channels…</Text>
      ) : (
        <>
          <MobilePanel>
            <View style={styles.rowBetween}>
              <View style={local.shrink}>
                <Text style={styles.overline}>Can send</Text>
                <MobileAmount sats={liquidity.spendableSat} style={styles.h3} />
              </View>
              <View style={[local.shrink, { alignItems: 'flex-end' }]}>
                <Text style={styles.overline}>Can receive</Text>
                <MobileAmount sats={liquidity.receivableSat} style={styles.h3} />
              </View>
            </View>
            <SplitBar share={liquidity.spendableSat + liquidity.receivableSat === 0n ? 0 : localShare({ localSat: liquidity.spendableSat, remoteSat: liquidity.receivableSat })} />
            <Text style={styles.faint}>
              {`${liquidity.activeChannels} active channel${liquidity.activeChannels === 1 ? '' : 's'}`}
              {liquidity.inactiveChannels > 0 ? `, ${liquidity.inactiveChannels} inactive (not counted)` : ''}
              {liquidity.reservesApplied ? '. Channel reserves are already subtracted.' : '. Channel reserves are not known over this connection, so the real figures are slightly lower.'}
            </Text>
          </MobilePanel>
          {advice !== null && (
            <MobileWarningBand tone={advice.tone}>
              <Text style={styles.bandText}>{advice.message}</Text>
              {advice.action !== null ? (
                <>
                  <Text style={styles.faint}>{advice.action.explanation}</Text>
                  <MobileButton
                    label={advice.action.label}
                    compact
                    onPress={() => {
                      const action = advice.action;
                      if (action === null) return;
                      controller.swaps.beginDraft(action.direction, action.amountSat);
                      controller.navigate('swap-flow', { direction: action.direction, amount: action.amountSat.toString() });
                    }}
                  />
                </>
              ) : advice.actionUnavailable !== null ? (
                <Text style={styles.faint}>{advice.actionUnavailable}</Text>
              ) : null}
            </MobileWarningBand>
          )}
          {pending.map((s) => (
            <MobileNavRow
              key={s.id}
              label={`${DIRECTION_LABEL[s.direction]} in progress`}
              detail={`${groupSats(s.amountSat)} sats · view swap progress`}
              onPress={() => controller.navigate('swap', { id: s.id })}
            />
          ))}
          <MobilePanel title="Check a payment">
            <MobileField
              label="Amount (sats)"
              value={checkText}
              onChangeText={setCheckText}
              placeholder="50000"
              hint="See whether your channels can send or receive this amount right now."
            />
            {checkAmount !== null && (
              <CapacityCheck
                receive={receiveCapacityWarning(liquidity, checkAmount)}
                send={sendCapacityWarning(liquidity, checkAmount)}
              />
            )}
          </MobilePanel>
          <MobilePanel title="Channels">
            {liquidity.channels.length === 0 && <Text style={styles.dim}>No channels.</Text>}
            {liquidity.channels.map((c, i) => (
              <View key={c.chanId} style={[{ gap: 6, paddingVertical: 8 }, i > 0 ? { borderTopWidth: 1, borderTopColor: mobilePalette.border } : null]}>
                <View style={styles.rowBetween}>
                  <Text style={[styles.value, local.shrink]} numberOfLines={1}>
                    {c.label}
                  </Text>
                  <MobileBadge label={c.active ? 'Active' : 'Inactive'} tone={c.active ? 'positive' : 'neutral'} />
                </View>
                <SplitBar share={localShare(c)} dim={!c.active} />
                <View style={styles.rowBetween}>
                  <Text style={styles.faint}>
                    Send <MobileAmount sats={c.sendableSat} style={styles.faint} />
                  </Text>
                  <Text style={styles.faint}>
                    Receive <MobileAmount sats={c.receivableSat} style={styles.faint} />
                  </Text>
                </View>
                {!c.active && <Text style={styles.faint}>Inactive channels can't carry payments until the peer is back online.</Text>}
              </View>
            ))}
            {channelState.status === 'failed' && <Text style={styles.faint}>Channel details could not be read: {channelState.error}</Text>}
            <Text style={styles.faint}>Orange is your side (what you can send), teal is the peer's side (what you can receive).</Text>
          </MobilePanel>
          <MobileNavRow label="Transfers & swaps" detail="Move funds between Lightning and on-chain" onPress={() => controller.navigate('transfers')} />
          <Text style={styles.faint}>Opening and closing channels needs a continuously connected node — do it from the desktop app.</Text>
        </>
      )}
    </MobileScreen>
  );
}

function CapacityCheck({ receive, send }: { receive: string | null; send: string | null }): ReactNode {
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.dim, receive === null ? null : { color: mobilePalette.warning }]}>
        {receive ?? 'Receiving: your channels can take this amount.'}
      </Text>
      <Text style={[styles.dim, send === null ? null : { color: mobilePalette.warning }]}>
        {send ?? 'Sending: your channels can send this amount (before routing fees).'}
      </Text>
    </View>
  );
}

/** Mode A: Wavelength's availability — no channels, so nothing to rebalance. */
export function WavelengthLiquidityScreen({
  controller,
  state,
}: {
  controller: ModeAController;
  state: ModeAState;
}): ReactNode {
  const buckets = state.balances;
  const availability = buckets === null ? null : wavelengthAvailability(buckets, state.vtxo);
  return (
    <MobileScreen>
      <MobileHeader title="Liquidity" subtitle="What this wallet can spend now" onBack={() => controller.goBack()} />
      {availability === null ? (
        <Text style={styles.dim}>Reading balances…</Text>
      ) : (
        <>
          <MobilePanel>
            <AmountFact label="Spendable now" sats={availability.spendableSat} strong note="For Lightning payments and on-chain withdrawals." />
            <AmountFact label="In flight" sats={availability.pendingSat} note="Payments not settled yet." />
            <AmountFact label="On-chain deposits" sats={availability.onchainSat} note="Spendable once confirmed and included in a batch." />
            <AmountFact label="Expiring or at risk" sats={availability.expiringSat} note="Part of the spendable balance whose batch needs renewing." />
          </MobilePanel>
          {availability.notes.map((note) => (
            <MobileWarningBand key={note} tone="warning">
              {note}
            </MobileWarningBand>
          ))}
          <MobilePanel title="No channels to manage">
            <Text style={styles.dim}>
              This everyday wallet has no Lightning channels, so there is no sending or receiving capacity to balance and no Loop. Lightning
              payments go through Wavelength's swap service, which quotes each payment's fee before you confirm. Any limit it sets is shown
              when you request a quote or an invoice.
            </Text>
          </MobilePanel>
          <MobileNavRow label="Transfers" detail="Deposit, withdraw and pay" onPress={() => controller.navigate('transfers')} />
        </>
      )}
    </MobileScreen>
  );
}

/**
 * Transfers & swaps: pick FROM and TO, see the rails the active backend has
 * for that pair (resolved by `resolveTransferRoutes`), and continue — inline
 * for a Loop swap, or in the screen that owns the rail (Send, Receive,
 * Assets). A pair with no rail says why; a rail that can't run now says why
 * and what would fix it.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import {
  MobileBadge,
  MobileButton,
  MobileHeader,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  styles,
} from '../Primitives.js';
import type {
  LoopDirection,
  RouteAction,
  RouteEnv,
  TransferEndpointId,
} from '../../flows/transfers.js';
import {
  hasRail,
  resolveTransferRoutes,
  transferDestinations,
  transferSources,
} from '../../flows/transfers.js';
import { Bullets, ChoiceRow, SimulatedBanner, local } from './parts.js';

type Handoff = Extract<RouteAction, { kind: 'handoff' }>['to'];

export function TransfersScreen({
  env,
  simulated,
  onBack,
  onStartSwap,
  onHandoff,
  extra,
  initialFrom,
}: {
  env: RouteEnv;
  simulated: boolean;
  onBack: () => void;
  onStartSwap: (direction: LoopDirection) => void;
  onHandoff: (to: Handoff) => void;
  /** Backend-specific content under the picker (swap history link, notes). */
  extra?: ReactNode;
  initialFrom?: TransferEndpointId;
}): ReactNode {
  const sources = transferSources(env.backend);
  const destinations = transferDestinations(env.backend);
  const [from, setFrom] = useState<TransferEndpointId>(initialFrom ?? sources[0]?.id ?? 'wallet');
  const [to, setTo] = useState<TransferEndpointId | null>(null);
  const resolution = to === null ? null : resolveTransferRoutes(from, to, env);

  return (
    <MobileScreen>
      <MobileHeader
        title="Transfers & swaps"
        subtitle={env.backend === 'remote-lnd' ? 'Move funds with your node' : 'Move funds in and out of this wallet'}
        onBack={onBack}
      />
      <SimulatedBanner show={simulated} what="balances, routes and swap quotes" />
      <MobilePanel title="From">
        <View style={local.list} accessibilityRole="radiogroup" accessibilityLabel="From">
          {sources.map((s) => (
            <ChoiceRow
              key={s.id}
              label={s.label}
              detail={s.detail}
              selected={s.id === from}
              onPress={() => {
                setFrom(s.id);
                setTo(null);
              }}
            />
          ))}
        </View>
      </MobilePanel>
      <MobilePanel title="To">
        <View style={local.list} accessibilityRole="radiogroup" accessibilityLabel="To">
          {destinations
            .filter((d) => d.id !== from)
            .map((d) => (
              <ChoiceRow
                key={d.id}
                label={d.label}
                detail={d.detail}
                selected={d.id === to}
                onPress={() => setTo(d.id)}
                disabledNote={hasRail(env.backend, from, d.id) ? undefined : 'No route'}
              />
            ))}
        </View>
      </MobilePanel>
      {resolution === null && <Text style={styles.faint}>Choose where the funds should go to see how.</Text>}
      {resolution?.noRoute !== undefined && (
        <MobileWarningBand tone="warning">
          <Text style={styles.bandText}>{resolution.noRoute.reason}</Text>
          {resolution.noRoute.fix !== undefined && <Text style={styles.faint}>{resolution.noRoute.fix}</Text>}
        </MobileWarningBand>
      )}
      {resolution?.candidates.map(({ adapter, blocker }) => (
        <MobilePanel key={adapter.rail}>
          <View style={styles.rowBetween}>
            <Text style={styles.h3}>{adapter.label}</Text>
            <MobileBadge label={blocker === null ? 'Available' : 'Not available now'} tone={blocker === null ? 'positive' : 'warning'} />
          </View>
          <Text style={styles.faint}>{adapter.provider}</Text>
          <Text style={styles.dim}>{adapter.summary}</Text>
          <Text style={styles.faint}>Timing: {adapter.timing}</Text>
          <Bullets items={adapter.risks} />
          {blocker !== null ? (
            <MobileWarningBand tone="warning">
              <Text style={styles.bandText}>{blocker.reason}</Text>
              {blocker.fix !== undefined && <Text style={styles.faint}>{blocker.fix}</Text>}
            </MobileWarningBand>
          ) : adapter.action.kind === 'swap' ? (
            <MobileButton
              label={`Continue with ${adapter.label}`}
              onPress={() => {
                if (adapter.action.kind === 'swap') onStartSwap(adapter.action.direction);
              }}
            />
          ) : (
            <MobileButton
              label={adapter.action.label}
              kind="secondary"
              onPress={() => {
                if (adapter.action.kind === 'handoff') onHandoff(adapter.action.to);
              }}
            />
          )}
        </MobilePanel>
      ))}
      {extra}
    </MobileScreen>
  );
}

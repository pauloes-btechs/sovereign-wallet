/**
 * Entry points and routing for this track's screens, so the shared screen
 * switches need one line each:
 * - `ModeBMoneyScreen` renders every `MoneyRoute` for a remote node.
 * - `ModeAMoneyScreen` renders the everyday wallet's honest equivalents.
 * The Wallet tab's "Money" section links to `transfers`, `liquidity` and
 * `assets` on both backends.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { MobileNavRow, MobilePanel, styles } from '../Primitives.js';
import type { ModeBRemoteController, ModeBRemoteState } from '../../flows/modeBRemoteController.js';
import type { ModeAController, ModeAState } from '../../flows/modeAController.js';
import { currentEntry } from '../../flows/navigation.js';
import type { LoopDirection, ModeAMoneyRoute, MoneyRoute, RouteEnv } from '../../flows/transfers.js';
import { DIRECTION_LABEL, groupSats, isTerminal } from '../../flows/transfers.js';
import { TransfersScreen } from './TransfersScreen.js';
import { SwapFlowScreen, SwapHistoryScreen, SwapProgressScreen, useRemoteFunds } from './swapScreens.js';
import { RemoteLiquidityScreen, WavelengthLiquidityScreen } from '../liquidity/LiquidityScreens.js';
import {
  AssetDetailScreen,
  AssetListScreen,
  AssetReceiveScreen,
  AssetSendScreen,
  WavelengthAssetsScreen,
} from '../assets/AssetScreens.js';

const param = (state: { readonly nav: Parameters<typeof currentEntry>[0] | null }, key: string): string | null => {
  if (state.nav === null) return null;
  return currentEntry(state.nav).params?.[key] ?? null;
};

export function ModeBMoneyScreen({
  controller,
  state,
  route,
}: {
  controller: ModeBRemoteController;
  state: ModeBRemoteState;
  route: MoneyRoute;
}): ReactNode {
  const id = param(state, 'id') ?? '';
  switch (route) {
    case 'liquidity':
      return <RemoteLiquidityScreen controller={controller} state={state} />;
    case 'transfers':
      return <RemoteTransfers controller={controller} state={state} />;
    case 'swap-flow': {
      const d = param(state, 'direction');
      const direction: LoopDirection = d === 'loop-in' ? 'loop-in' : 'loop-out';
      return <SwapFlowScreen controller={controller} state={state} direction={direction} amountParam={param(state, 'amount')} />;
    }
    case 'swap':
      return <SwapProgressScreen controller={controller} swapId={id} />;
    case 'swaps':
      return <SwapHistoryScreen controller={controller} />;
    case 'assets':
      return <AssetListScreen controller={controller} />;
    case 'asset':
      return <AssetDetailScreen controller={controller} assetId={id} />;
    case 'asset-receive':
      return <AssetReceiveScreen controller={controller} assetId={id} />;
    case 'asset-send':
      return <AssetSendScreen controller={controller} assetId={id} />;
  }
}

function RemoteTransfers({ controller, state }: { controller: ModeBRemoteController; state: ModeBRemoteState }): ReactNode {
  const swaps = useSyncExternalStore(controller.swaps.subscribe, controller.swaps.getState);
  const assets = useSyncExternalStore(controller.assets.subscribe, controller.assets.getState);
  const { funds, liquidity } = useRemoteFunds(controller, state);
  const caps = controller.walletCapabilities();
  useEffect(() => {
    void controller.channels.load();
    if (caps.features.loopSwaps.available) void controller.swaps.loadTerms();
    if (controller.swaps.surface().monitor) void controller.swaps.loadSwaps();
    if (caps.features.taprootAssets.available) void controller.assets.load();
  }, [controller, caps.features.loopSwaps.available, caps.features.taprootAssets.available]);

  const env: RouteEnv = {
    backend: 'remote-lnd',
    features: caps.features,
    lightningSpendableSat: funds?.lightningSpendableSat ?? null,
    onchainSat: funds?.onchainSat ?? null,
    receivableSat: funds?.receivableSat ?? null,
    activeChannels: liquidity?.activeChannels ?? null,
    loopRunnable: caps.features.loopSwaps.available,
    loopTermsError: swaps.termsStatus === 'failed' ? swaps.termsError : null,
    assetCount: assets.assets?.length ?? null,
  };
  const pending = (swaps.swaps ?? []).filter((s) => !isTerminal(s.state));
  return (
    <TransfersScreen
      env={env}
      simulated={controller.isSimulated()}
      onBack={() => controller.goBack()}
      onStartSwap={(direction) => {
        controller.swaps.beginDraft(direction);
        controller.navigate('swap-flow', { direction });
      }}
      onHandoff={(to) => {
        if (to === 'send-lightning' || to === 'send-onchain') controller.navigate('send');
        else if (to === 'receive-lightning' || to === 'receive-onchain') controller.navigate('receive');
        else controller.navigate('assets');
      }}
      extra={
        <>
          {pending.map((s) => (
            <MobileNavRow
              key={s.id}
              label={`${DIRECTION_LABEL[s.direction]} in progress`}
              detail={`${groupSats(s.amountSat)} sats · view swap progress`}
              onPress={() => controller.navigate('swap', { id: s.id })}
            />
          ))}
          {controller.swaps.surface().monitor && (
            <MobileNavRow label="Swap history" detail="Loop swaps on your node, with status and costs" onPress={() => controller.navigate('swaps')} />
          )}
        </>
      }
    />
  );
}

export function ModeAMoneyScreen({
  controller,
  state,
  route,
}: {
  controller: ModeAController;
  state: ModeAState;
  route: ModeAMoneyRoute;
}): ReactNode {
  switch (route) {
    case 'liquidity':
      return <WavelengthLiquidityScreen controller={controller} state={state} />;
    case 'assets':
      return <WavelengthAssetsScreen controller={controller} />;
    case 'transfers': {
      const caps = controller.walletCapabilities();
      const env: RouteEnv = {
        backend: 'wavelength',
        features: caps.features,
        lightningSpendableSat: state.balances?.lightningSpendableSat ?? null,
        onchainSat: null,
        receivableSat: null,
        activeChannels: null,
        loopRunnable: false,
        loopTermsError: null,
        assetCount: null,
      };
      return (
        <TransfersScreen
          env={env}
          simulated={false}
          onBack={() => controller.goBack()}
          onStartSwap={() => undefined}
          onHandoff={(to) => {
            if (to === 'send-lightning' || to === 'send-onchain') {
              controller.setSendKind(to === 'send-lightning' ? 'lightning' : 'onchain');
              controller.navigate('send');
            } else if (to === 'receive-lightning' || to === 'receive-onchain') {
              controller.setReceiveTab(to === 'receive-lightning' ? 'lightning' : 'onchain');
              controller.navigate('receive');
            }
          }}
          extra={
            <MobilePanel title="About Loop">
              <Text style={styles.faint}>
                Loop In and Loop Out need your own Lightning node. This everyday wallet moves funds through its Ark operator and
                Wavelength's swap service instead; each route above shows its quote before you confirm.
              </Text>
            </MobilePanel>
          }
        />
      );
    }
  }
}

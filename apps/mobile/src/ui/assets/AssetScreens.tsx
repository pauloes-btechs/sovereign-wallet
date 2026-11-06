/**
 * Taproot Assets on a remote node (Mode B): list, detail with transfer
 * history, receive (fixed-amount address + QR) and send (the node decodes
 * the address → review → send). Every asset shows "Issuer unverified": this
 * build has no verification source, and a name proves nothing. The everyday
 * wallet (Mode A) holds no assets and says so.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  MobileBadge,
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileField,
  MobileHeader,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles,
} from '../Primitives.js';
import { QrCode } from '../QrCode.js';
import type { ModeBRemoteController } from '../../flows/modeBRemoteController.js';
import type { ModeAController } from '../../flows/modeAController.js';
import type { RemoteAsset, RemoteAssetTransfer } from '../../flows/assets.js';
import {
  STABLECOIN_WARNING,
  UNVERIFIED_EXPLANATION,
  assetTrust,
  formatAssetUnits,
} from '../../flows/assets.js';
import { AmountFact, CopyableId, Fact, SimulatedBanner, local, utcTime } from '../transfers/parts.js';
import { shortenMiddle } from '../format.js';
import { useDeviceAuthorization } from '../transfers/authorize.js';

function TrustBadges({ asset }: { asset: RemoteAsset }): ReactNode {
  const trust = assetTrust(asset);
  return (
    <View style={[styles.rowStart, { flexWrap: 'wrap' }]}>
      <MobileBadge
        label={trust.trust === 'issuer-verified' ? 'Issuer verified' : 'Issuer unverified'}
        tone={trust.trust === 'issuer-verified' ? 'positive' : 'warning'}
      />
      {trust.stablecoinImpersonationRisk && <MobileBadge label="Possible imitation" tone="danger" />}
    </View>
  );
}

export function AssetListScreen({ controller }: { controller: ModeBRemoteController }): ReactNode {
  const assets = useSyncExternalStore(controller.assets.subscribe, controller.assets.getState);
  const feature = controller.walletCapabilities().features.taprootAssets;
  useEffect(() => {
    if (feature.available) void controller.assets.load();
  }, [controller, feature.available]);

  return (
    <MobileScreen>
      <MobileHeader title="Assets" subtitle="Taproot Assets on your node" onBack={() => controller.goBack()} />
      {!feature.available ? (
        <MobileWarningBand tone="warning">{feature.reason}</MobileWarningBand>
      ) : (
        <>
          <SimulatedBanner show={controller.isSimulated()} what="assets, addresses and transfers" />
          {assets.assetsStatus === 'failed' && <MobileErrorNote error={`Assets could not be read: ${assets.assetsError ?? ''}`} />}
          {assets.assets === null && assets.assetsStatus === 'loading' && <Text style={styles.dim}>Reading assets…</Text>}
          {assets.assets !== null && assets.assets.length === 0 && (
            <MobilePanel>
              <Text style={styles.dim}>Your node holds no Taproot Assets.</Text>
            </MobilePanel>
          )}
          {(assets.assets ?? []).map((a) => (
            <Pressable
              key={a.assetIdHex}
              accessibilityRole="button"
              accessibilityLabel={`${a.name}, issuer unverified, balance ${formatAssetUnits(a.balance, a.decimalDisplay)} units`}
              onPress={() => controller.navigate('asset', { id: a.assetIdHex })}
              style={local.rowCard}
            >
              <View style={styles.rowBetween}>
                <Text style={[styles.value, local.shrink]} numberOfLines={1}>
                  {a.name}
                </Text>
                <Text style={styles.value}>{formatAssetUnits(a.balance, a.decimalDisplay)}</Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={[styles.faint, styles.mono]}>{shortenMiddle(a.assetIdHex, 8, 6)}</Text>
                <Text style={styles.faint}>units</Text>
              </View>
              <TrustBadges asset={a} />
            </Pressable>
          ))}
          <Text style={styles.faint}>{UNVERIFIED_EXPLANATION}</Text>
        </>
      )}
    </MobileScreen>
  );
}

export function AssetDetailScreen({ controller, assetId }: { controller: ModeBRemoteController; assetId: string }): ReactNode {
  const assets = useSyncExternalStore(controller.assets.subscribe, controller.assets.getState);
  useEffect(() => {
    void controller.assets.load();
  }, [controller]);
  const asset = assets.assets?.find((a) => a.assetIdHex === assetId) ?? null;
  const surface = controller.assets.surface();
  const unconfirmed = (assets.transfers ?? []).some((t) => t.assetIdHex === assetId && t.status === 'unconfirmed');
  useEffect(() => {
    // Follow pending transfers until their anchor transaction confirms.
    if (!unconfirmed) return undefined;
    const timer = setInterval(() => void controller.assets.load(), 5_000);
    return () => clearInterval(timer);
  }, [controller, unconfirmed]);
  if (asset === null) {
    return (
      <MobileScreen>
        <MobileHeader title="Asset" onBack={() => controller.goBack()} />
        <Text style={styles.dim}>{assets.assetsStatus === 'loaded' ? 'Your node no longer lists this asset.' : 'Reading the asset…'}</Text>
      </MobileScreen>
    );
  }
  const trust = assetTrust(asset);
  const transfers = controller.assets.transfersFor(asset.assetIdHex);
  return (
    <MobileScreen>
      <MobileHeader title={asset.name} subtitle="Taproot Asset" onBack={() => controller.goBack()} />
      <SimulatedBanner show={controller.isSimulated()} what="the asset and its transfers" />
      <MobilePanel>
        <Text style={styles.overline}>Balance</Text>
        <Text style={styles.h2}>{formatAssetUnits(asset.balance, asset.decimalDisplay)} units</Text>
        <TrustBadges asset={asset} />
      </MobilePanel>
      {trust.stablecoinImpersonationRisk && <MobileWarningBand tone="danger">{STABLECOIN_WARNING}</MobileWarningBand>}
      <MobileButtonGroup row>
        <MobileButton
          label="Receive"
          kind="secondary"
          disabled={!surface.receive}
          onPress={() => {
            controller.assets.beginReceive(asset.assetIdHex);
            controller.navigate('asset-receive', { id: asset.assetIdHex });
          }}
        />
        <MobileButton
          label="Send"
          disabled={!surface.send || asset.balance === 0n}
          onPress={() => {
            controller.assets.beginSend(asset.assetIdHex);
            controller.navigate('asset-send', { id: asset.assetIdHex });
          }}
        />
      </MobileButtonGroup>
      {(!surface.receive || !surface.send) && (
        <Text style={styles.faint}>
          {!surface.send ? "Sending assets isn't available over this connection. " : ''}
          {!surface.receive ? "Creating asset addresses isn't available over this connection." : ''}
        </Text>
      )}
      <MobilePanel title="Details">
        <CopyableId label="Asset ID" value={asset.assetIdHex} />
        <Fact label="Type">{asset.type === 'collectible' ? 'Collectible' : 'Normal (divisible)'}</Fact>
        <Fact label="Issuer">Unverified — no verification source in this app</Fact>
        {asset.decimalDisplay !== null && <Fact label="Decimal places (issuer's claim)">{String(asset.decimalDisplay)}</Fact>}
        {asset.groupKeyHex !== null && <CopyableId label="Group key" value={asset.groupKeyHex} />}
        {asset.genesisPoint !== null && <CopyableId label="Genesis outpoint" value={asset.genesisPoint} />}
        <Text style={styles.faint}>{UNVERIFIED_EXPLANATION}</Text>
      </MobilePanel>
      <MobilePanel title="Transfers">
        {assets.transfersStatus === 'unavailable' && <Text style={styles.dim}>Transfer history isn't available over this connection.</Text>}
        {assets.transfersStatus === 'failed' && <MobileErrorNote error={`Transfers could not be read: ${assets.transfersError ?? ''}`} />}
        {assets.transfersStatus === 'loaded' && transfers.length === 0 && <Text style={styles.dim}>No transfers of this asset yet.</Text>}
        {transfers.map((t, i) => (
          <TransferRow key={`${t.txid}-${t.direction}`} transfer={t} asset={asset} divider={i > 0} />
        ))}
      </MobilePanel>
    </MobileScreen>
  );
}

function TransferRow({ transfer, asset, divider }: { transfer: RemoteAssetTransfer; asset: RemoteAsset; divider: boolean }): ReactNode {
  return (
    <View style={[{ gap: 4, paddingVertical: 8 }, divider ? { borderTopWidth: 1, borderTopColor: mobilePalette.border } : null]}>
      <View style={styles.rowBetween}>
        <Text style={styles.value}>{transfer.direction === 'out' ? 'Sent' : 'Received'}</Text>
        <Text style={styles.value}>
          {transfer.direction === 'out' ? '−' : '+'}
          {formatAssetUnits(transfer.amount, asset.decimalDisplay)} units
        </Text>
      </View>
      <View style={styles.rowBetween}>
        <Text style={styles.faint}>{utcTime(transfer.at)}</Text>
        <MobileBadge
          label={transfer.status === 'confirmed' ? `Confirmed${transfer.blockHeight === null ? '' : ` · block ${transfer.blockHeight}`}` : 'Waiting for confirmation'}
          tone={transfer.status === 'confirmed' ? 'positive' : 'info'}
        />
      </View>
      {transfer.chainFeeSat !== null && (
        <AmountFact label="On-chain fee paid" sats={transfer.chainFeeSat} />
      )}
      <Text style={[styles.faint, styles.mono]} selectable>
        {shortenMiddle(transfer.txid, 12, 8)}
      </Text>
    </View>
  );
}

export function AssetReceiveScreen({ controller, assetId }: { controller: ModeBRemoteController; assetId: string }): ReactNode {
  const assets = useSyncExternalStore(controller.assets.subscribe, controller.assets.getState);
  const asset = controller.assets.asset(assetId);
  const receive = assets.receive?.assetIdHex === assetId ? assets.receive : null;
  useEffect(() => {
    if (controller.assets.getState().receive?.assetIdHex !== assetId) controller.assets.beginReceive(assetId);
  }, [controller, assetId]);
  if (asset === null || receive === null) {
    return (
      <MobileScreen>
        <MobileHeader title="Receive asset" onBack={() => controller.goBack()} />
        <Text style={styles.dim}>Reading the asset…</Text>
      </MobileScreen>
    );
  }
  return (
    <MobileScreen>
      <MobileHeader title={`Receive ${asset.name}`} subtitle="A Taproot Assets address for a fixed amount" onBack={() => controller.goBack()} />
      <SimulatedBanner show={controller.isSimulated()} what="the address" />
      <MobileField
        label="Amount (units)"
        value={receive.amountText}
        onChangeText={(t) => controller.assets.editReceiveAmount(t)}
        placeholder="100"
        hint="The sender pays exactly this amount of this asset."
      />
      <MobileErrorNote error={receive.error} />
      <MobileButton
        label={receive.busy ? 'Creating address…' : 'Create address'}
        busy={receive.busy}
        onPress={() => void controller.assets.createReceiveAddress()}
      />
      {receive.address !== null && (
        <MobilePanel>
          <QrCode value={receive.address} label={`QR code for a ${asset.name} address`} textLabel="Taproot Assets address" />
          <Text style={styles.faint}>
            Only this asset, in exactly this amount, can be sent to this address. Your node's Taproot Assets daemon must be online to
            receive the transfer proof.
            {controller.isSimulated() ? ' Nothing in the simulation pays this address.' : ''}
          </Text>
        </MobilePanel>
      )}
    </MobileScreen>
  );
}

export function AssetSendScreen({ controller, assetId }: { controller: ModeBRemoteController; assetId: string }): ReactNode {
  const assets = useSyncExternalStore(controller.assets.subscribe, controller.assets.getState);
  const asset = controller.assets.asset(assetId);
  const auth = useDeviceAuthorization();
  const [authNote, setAuthNote] = useState<string | null>(null);
  const send = assets.send?.assetIdHex === assetId ? assets.send : null;
  useEffect(() => {
    if (controller.assets.getState().send?.assetIdHex !== assetId) controller.assets.beginSend(assetId);
  }, [controller, assetId]);
  if (asset === null || send === null) {
    return (
      <MobileScreen>
        <MobileHeader title="Send asset" onBack={() => controller.goBack()} />
        <Text style={styles.dim}>Reading the asset…</Text>
      </MobileScreen>
    );
  }
  const trust = assetTrust(asset);
  const step = send.stage === 'sent' ? 'Sent' : send.stage === 'review' || send.stage === 'sending' ? 'Review' : 'Address';
  return (
    <MobileScreen>
      <MobileHeader
        title={`Send ${asset.name}`}
        subtitle={`Step: ${step}`}
        onBack={() => {
          if (send.stage === 'review') controller.assets.backToEditSend();
          else controller.goBack();
        }}
      />
      <SimulatedBanner show={controller.isSimulated()} what="the send and its fee" />
      {(send.stage === 'edit' || send.stage === 'decoding') && (
        <>
          <AmountFactUnits label="You hold" units={asset.balance} decimals={asset.decimalDisplay} />
          <MobileField
            label="Taproot Assets address"
            value={send.addressText}
            onChangeText={(t) => controller.assets.editSendAddress(t)}
            placeholder={controller.network === 'regtest' ? 'taprt1…' : controller.network === 'mainnet' ? 'tapbc1…' : 'taptb1…'}
            hint="The address fixes the asset and the amount. Your node decodes it before anything is sent."
            multiline
          />
          <MobileErrorNote error={send.error} />
          <MobileButton
            label={send.stage === 'decoding' ? 'Checking address…' : 'Review send'}
            busy={send.stage === 'decoding'}
            disabled={send.addressText.trim() === ''}
            onPress={() => void controller.assets.reviewSend()}
          />
        </>
      )}
      {(send.stage === 'review' || send.stage === 'sending') && send.decoded !== null && (
        <>
          <MobilePanel title="Review">
            <Fact label="From">{"Your node's Taproot Assets"}</Fact>
            <Fact label="Asset">{`${asset.name} (${trust.trust === 'issuer-verified' ? 'issuer verified' : 'issuer unverified'})`}</Fact>
            <AmountFactUnits label="Amount" units={send.decoded.amount} decimals={asset.decimalDisplay} strong />
            <AmountFactUnits label="Left after sending" units={asset.balance - send.decoded.amount} decimals={asset.decimalDisplay} />
            <Fact label="To" note="Decoded by your node.">{shortenMiddle(send.addressText.trim(), 14, 10)}</Fact>
            <Fact label="On-chain fee" note="Your node's Taproot Assets daemon picks the fee rate when it builds the anchor transaction; there is no quote beforehand. The fee paid is shown once sent.">
              Paid in sats by your node
            </Fact>
            <Fact label="Timing">Final when the anchor transaction confirms.</Fact>
          </MobilePanel>
          <MobileWarningBand tone="warning">
            Asset sends can't be reversed. Check the address came from the person you are paying.
          </MobileWarningBand>
          <Text style={styles.faint}>
            {controller.assets.hasDeviceAuthorization() ? 'You will be asked to authorize this on your device.' : auth.description}
          </Text>
          <MobileErrorNote error={send.error ?? authNote} />
          <MobileButtonGroup>
            <MobileButton
              label={send.stage === 'sending' ? 'Sending…' : `Send ${formatAssetUnits(send.decoded.amount, asset.decimalDisplay)} units`}
              busy={send.stage === 'sending'}
              onPress={() => {
                setAuthNote(null);
                void auth.request(`Approve sending ${asset.name}`).then((ok) => {
                  if (ok) void controller.assets.confirmSend();
                  else setAuthNote('Not authorized, so nothing was sent.');
                });
              }}
            />
            <MobileButton label="Change address" kind="ghost" disabled={send.stage === 'sending'} onPress={() => controller.assets.backToEditSend()} />
          </MobileButtonGroup>
          {auth.sheet}
        </>
      )}
      {send.stage === 'sent' && send.result !== null && send.decoded !== null && (
        <>
          <MobileWarningBand tone="positive">
            Sent. Your node broadcast the anchor transaction; the transfer is final once it confirms.
          </MobileWarningBand>
          <MobilePanel title="Receipt">
            <AmountFactUnits label="Amount" units={send.decoded.amount} decimals={asset.decimalDisplay} />
            {send.result.chainFeeSat !== null ? (
              <AmountFact label="On-chain fee paid" sats={send.result.chainFeeSat} />
            ) : (
              <Fact label="On-chain fee paid">Not reported by your node</Fact>
            )}
            <CopyableId label="Anchor transaction" value={send.result.txid} />
          </MobilePanel>
          <MobileButton label="Back to asset" kind="secondary" onPress={() => controller.goBack()} />
        </>
      )}
    </MobileScreen>
  );
}

function AmountFactUnits({ label, units, decimals, strong = false }: { label: string; units: bigint; decimals: number | null; strong?: boolean }): ReactNode {
  return (
    <Fact label={label} strong={strong}>
      {`${formatAssetUnits(units, decimals)} units`}
    </Fact>
  );
}

/** Mode A: Wavelength holds no Taproot Assets. */
export function WavelengthAssetsScreen({ controller }: { controller: ModeAController }): ReactNode {
  const feature = controller.walletCapabilities().features.taprootAssets;
  return (
    <MobileScreen>
      <MobileHeader title="Assets" onBack={() => controller.goBack()} />
      <MobilePanel>
        <Text style={styles.h3}>Not supported in this wallet</Text>
        <Text style={styles.dim}>{feature.available ? 'Taproot Assets are available.' : feature.reason}</Text>
        <Text style={styles.faint}>
          The everyday wallet (Wavelength) holds only bitcoin. Taproot Assets need a Lightning node with the Taproot Assets daemon (litd); connect
          one in remote-node mode to see its assets here.
        </Text>
      </MobilePanel>
    </MobileScreen>
  );
}

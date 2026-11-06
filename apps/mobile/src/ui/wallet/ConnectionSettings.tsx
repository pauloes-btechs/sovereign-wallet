/**
 * Privacy, Network and connection, and Wallet management.
 *
 * Privacy claims are limited to what the active backend can back: there is
 * no Tor support, the services each wallet talks to are disclosed from the
 * provider's declaration, and the app collects no diagnostics.
 *
 * The Bitcoin network is fixed per wallet: the app offers no network switch,
 * so mainnet and test wallets can never share state.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { describeDependencyKind, describeRequiredFor, vtxoStateLabel } from '@sovereign/ui/copy';
import type { RemoteSessionSummary } from '../../flows/modeBRemoteController.js';
import { DESKTOP_ONLY_DISCLOSURE } from '../../flows/modeBRemoteController.js';
import { validateWalletName, WALLET_NAME_MAX_LENGTH } from '../../flows/preferences.js';
import { usePlatformServices, usePreferences } from '../appContext.js';
import { shortenMiddle } from '../format.js';
import {
  MobileButton,
  MobileButtonGroup,
  MobileErrorNote,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles as base,
  utcClock,
} from '../Primitives.js';
import { Sheet } from '../Sheet.js';
import { CapabilitySummary } from '../walletScreens.js';
import { connectionSummary, defaultWalletName, walletCapabilities, walletTypeLabel } from './host.js';
import type { WalletHost } from './host.js';
import { SettingInput, SettingRow, SettingsSection, ToggleRow } from './kit.js';
import { PreferencesStatus, SubHeader, WALLET_SUMMARY_FEATURES, useSetPreference } from './common.js';

// ——— Privacy ———

export function PrivacyScreen({ host }: { host: WalletHost }): ReactNode {
  const { preferences, error, set } = useSetPreference();
  const caps = walletCapabilities(host);
  const capture = caps.features.screenCaptureProtection;

  return (
    <MobileScreen>
      <SubHeader host={host} route="walletPrivacy" />

      <SettingsSection title="Network privacy">
        <SettingRow
          label="Tor"
          value="Not supported"
          description="This app connects over your normal internet connection. The services below can see your IP address and when you connect."
        />
        <SettingRow
          label="Connection endpoints"
          value="Fixed"
          description={
            host.kind === 'wavelength'
              ? 'The Ark operator and swap service are set by this wallet build; the app has no setting to choose others.'
              : 'Traffic goes through the Lightning Node Connect mailbox chosen when the session was created on your node. The app has no setting to change it.'
          }
        />
      </SettingsSection>

      {host.kind === 'wavelength' ? (
        <SettingsSection
          title="Services this wallet talks to"
          footnote="Taken word for word from the wallet's own declaration."
        >
          {host.controller.capabilities.operatorDependencies.map((dependency) => (
            <SettingRow
              key={dependency.kind}
              label={describeDependencyKind(dependency.kind)}
              description={dependency.disclosure}
            >
              <Text style={base.faint}>
                Needed for: {dependency.requiredFor.map((use) => describeRequiredFor(use).toLowerCase()).join(', ')}
              </Text>
            </SettingRow>
          ))}
        </SettingsSection>
      ) : (
        <SettingsSection title="Services this connection uses">
          <SettingRow
            label="Your node"
            description="Sees every payment and invoice you make from this phone, as it would from any other app connected to it."
          />
          <SettingRow
            label="LNC mailbox relay"
            description="Relays the end-to-end encrypted connection between this phone and your node. It cannot read the traffic, but it sees connection metadata such as timing, size and IP addresses. Lightning Labs runs the default mailbox."
          />
          <SettingRow
            label="Lightning network"
            description="Payments are routed by your node through its channels, as usual for Lightning; routing nodes see the payment amounts they forward."
          />
        </SettingsSection>
      )}

      <SettingsSection title="On this device">
        <ToggleRow
          label="Hide balances"
          description="Masks every amount in the app until you turn it off."
          value={preferences.hideBalances}
          onChange={(hideBalances) => set({ hideBalances })}
        />
        <ToggleRow
          label="Hide from screenshots and app switcher"
          value={capture.available && preferences.screenCaptureProtection}
          disabledReason={capture.available ? null : capture.reason}
          onChange={(screenCaptureProtection) => set({ screenCaptureProtection })}
        />
        <SettingRow
          label="Address reuse"
          description={
            host.kind === 'wavelength'
              ? 'Receive gives a fresh deposit address each time you ask for one, so there is no reuse to warn about. Share each address once.'
              : "This connection can't create on-chain addresses, so the app never shows one to reuse. Use your node's tools to get a fresh address."
          }
        />
        <SettingRow
          label="Diagnostics"
          value="None collected"
          description="The app sends no analytics, crash reports or usage data. There is nothing to turn off."
        />
      </SettingsSection>
      <MobileErrorNote error={error} />
      <PreferencesStatus />
    </MobileScreen>
  );
}

// ——— Network and connection ———

export function NetworkScreen({ host }: { host: WalletHost }): ReactNode {
  return host.kind === 'wavelength' ? <EverydayNetwork host={host} /> : <RemoteNetwork host={host} />;
}

const FIXED_NETWORK_NOTE =
  'Each wallet belongs to one Bitcoin network. The app has no network switch, so mainnet and test funds or wallet data can never mix. Another network needs a separate wallet on its own build.';

function ServiceRows({ host }: { host: WalletHost }): ReactNode {
  const caps = walletCapabilities(host);
  const rows = [
    { id: 'lightningSend' as const, label: 'Lightning sending' },
    { id: 'lightningReceive' as const, label: 'Lightning receiving' },
    { id: 'onchainSend' as const, label: 'On-chain sending' },
    { id: 'onchainReceive' as const, label: 'On-chain receiving' },
  ];
  return (
    <SettingsSection title="Service availability">
      {rows.map(({ id, label }) => {
        const status = caps.features[id];
        return (
          <SettingRow
            key={id}
            label={label}
            badge={status.available ? { label: 'Available', tone: 'positive' } : { label: 'Not available', tone: 'neutral' }}
            description={status.available ? status.note : status.reason}
          />
        );
      })}
    </SettingsSection>
  );
}

function EverydayNetwork({ host }: { host: Extract<WalletHost, { kind: 'wavelength' }> }): ReactNode {
  const { state, controller } = host;
  const connection = connectionSummary(host);
  return (
    <MobileScreen>
      <SubHeader host={host} route="walletNetwork" />
      <SettingsSection title="Bitcoin network" footnote={FIXED_NETWORK_NOTE}>
        <SettingRow label="Network" value={host.network} />
      </SettingsSection>

      <SettingsSection title="Connection">
        <SettingRow label="Ark operator" badge={{ label: connection.label, tone: connection.tone }} />
        <SettingRow
          label="Wallet runtime"
          value={state.runtimeReady ? 'Running' : 'Not started'}
        />
        <SettingRow
          label="Last sync"
          value={
            state.balancesRefreshing
              ? 'Refreshing…'
              : state.balancesUpdatedAt === null
                ? 'Not read yet'
                : utcClock(state.balancesUpdatedAt)
          }
          description={state.vtxo === null ? undefined : `Funds: ${vtxoStateLabel(state.vtxo.state)}`}
        />
        {state.balancesError !== null && (
          <SettingRow label="Last error" description={state.balancesError} badge={{ label: 'Failed', tone: 'danger' }} />
        )}
      </SettingsSection>
      <MobileButton
        label="Check connection"
        kind="secondary"
        busy={state.balancesRefreshing}
        onPress={() => void controller.refreshBalances()}
      />
      {state.vtxo !== null && !state.vtxo.operatorReachable && (
        <MobileWarningBand tone="danger">
          The Ark operator can't be reached, so payments are paused. Your funds stay yours; if the
          operator stays away, they can leave through a unilateral exit. See How this wallet works.
        </MobileWarningBand>
      )}
      <ServiceRows host={host} />
      <Text style={base.faint}>
        Diagnostics: backend Wavelength, network {host.network}, runtime {state.runtimeReady ? 'running' : 'stopped'},
        operator {state.vtxo === null ? 'unknown' : state.vtxo.operatorReachable ? 'reachable' : 'unreachable'}, last read{' '}
        {state.balancesUpdatedAt === null ? 'never' : utcClock(state.balancesUpdatedAt)}.
      </Text>
    </MobileScreen>
  );
}

function RemoteNetwork({ host }: { host: Extract<WalletHost, { kind: 'remote-lnd' }> }): ReactNode {
  const { state, controller } = host;
  const caps = walletCapabilities(host);
  const platform = usePlatformServices();
  const connection = connectionSummary(host);
  const node = state.node;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const networkMismatch = node !== null && node.network !== '' && node.network !== host.network;

  return (
    <MobileScreen>
      <SubHeader host={host} route="walletNetwork" />
      <SettingsSection title="Bitcoin network" footnote={FIXED_NETWORK_NOTE}>
        <SettingRow label="This app" value={host.network} />
        <SettingRow label="Your node reports" value={node === null ? 'Unknown' : node.network} />
      </SettingsSection>
      {networkMismatch && (
        <MobileWarningBand tone="danger">
          Your node is on {node.network}, but this app was started for {host.network}. Don't send or
          receive until they match: pair with a node on {host.network}.
        </MobileWarningBand>
      )}

      <SettingsSection title="Connection">
        <SettingRow label="Status" badge={{ label: connection.label, tone: connection.tone }} />
        <SettingRow label="Transport" value="Lightning Node Connect" description="End-to-end encrypted through the LNC mailbox." />
        <SettingRow
          label="Payments"
          value={state.foregrounded ? 'Allowed while open' : 'Paused in background'}
          description="Payments run only while the app is open."
        />
        {checkedAt !== null && <SettingRow label="Last checked" value={utcClock(checkedAt)} />}
      </SettingsSection>
      <MobileErrorNote error={refreshError} />
      <MobileButtonGroup row>
        <MobileButton
          label="Refresh"
          kind="secondary"
          busy={refreshing}
          onPress={() => {
            setRefreshing(true);
            setRefreshError(null);
            controller
              .refresh()
              .then(() => setCheckedAt(Date.now()))
              .catch((e: unknown) => setRefreshError(`Your node didn't answer: ${e instanceof Error ? e.message : String(e)}`))
              .finally(() => setRefreshing(false));
          }}
        />
        <MobileButton label="Disconnect" kind="ghost" onPress={() => setConfirmDisconnect(true)} />
      </MobileButtonGroup>

      <SettingsSection title="Connected node">
        {node === null ? (
          <SettingRow label="Node" description="Node details load after pairing." />
        ) : (
          <>
            <SettingRow label="Alias" value={node.alias === '' ? 'No alias' : node.alias} />
            <SettingRow label="LND version" value={node.version} />
            <SettingRow label="Block height" value={String(node.blockHeight)} />
            <SettingRow label="Identity key" value={shortenMiddle(node.identityPubkey, 10, 8)} description="Public key — safe to share." />
          </>
        )}
      </SettingsSection>

      <SessionsSection host={host} bottomInset={platform.bottomInset} />
      <ServiceRows host={host} />
      <MobileWarningBand tone="warning">{DESKTOP_ONLY_DISCLOSURE}</MobileWarningBand>
      <Text style={base.faint}>
        Diagnostics: backend remote LND over LNC, app network {host.network}, node network{' '}
        {node?.network ?? 'unknown'}, connected {controller.isConnected() ? 'yes' : 'no'}, sessions{' '}
        {caps.features.sessionList.available ? 'readable' : 'not readable'}.
      </Text>

      <Sheet
        open={confirmDisconnect}
        title="Disconnect from your node?"
        onClose={() => setConfirmDisconnect(false)}
        bottomInset={platform.bottomInset}
        footer={
          <MobileButtonGroup>
            <MobileButton
              label="Disconnect"
              onPress={() => {
                setConfirmDisconnect(false);
                void controller.disconnect();
              }}
            />
            <MobileButton label="Cancel" kind="secondary" onPress={() => setConfirmDisconnect(false)} />
          </MobileButtonGroup>
        }
      >
        <Text style={base.dim}>
          This ends the connection on this phone. Your node and its funds are not affected. To
          connect again you need a pairing phrase from your node — the app doesn't keep the old one.
        </Text>
      </Sheet>
    </MobileScreen>
  );
}

const SESSION_STATE_LABEL: Record<RemoteSessionSummary['state'], { label: string; tone: 'positive' | 'neutral' | 'warning' | 'danger' }> = {
  'in-use': { label: 'In use', tone: 'positive' },
  created: { label: 'Not used yet', tone: 'neutral' },
  revoked: { label: 'Revoked', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

function SessionsSection({
  host,
  bottomInset,
}: {
  host: Extract<WalletHost, { kind: 'remote-lnd' }>;
  bottomInset?: number;
}): ReactNode {
  const caps = walletCapabilities(host);
  const list = caps.features.sessionList;
  const revoke = caps.features.sessionRevoke;
  const [sessions, setSessions] = useState<readonly RemoteSessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<RemoteSessionSummary | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = (): void => {
    setLoading(true);
    setError(null);
    host.controller
      .listSessions()
      .then(setSessions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  if (!list.available) {
    return (
      <SettingsSection title="Sessions">
        <SettingRow label="Connection sessions" value="Not available" description={list.reason} />
      </SettingsSection>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <SettingsSection title="Sessions">
        {sessions === null ? (
          <SettingRow label="Connection sessions" description="The sessions your node has created for apps like this one." />
        ) : sessions.length === 0 ? (
          <SettingRow label="Connection sessions" description="Your node reports no sessions." />
        ) : (
          sessions.map((session) => {
            const state = SESSION_STATE_LABEL[session.state];
            const active = session.state === 'in-use' || session.state === 'created';
            return (
              <SettingRow
                key={session.localPublicKey}
                label={session.label === '' ? 'Unnamed session' : session.label}
                badge={state}
                description={shortenMiddle(session.localPublicKey, 8, 6)}
              >
                {active && (
                  <MobileButton
                    label={`Revoke ${session.label === '' ? 'session' : session.label}`}
                    kind="ghost"
                    compact
                    disabled={!revoke.available}
                    onPress={() => setTarget(session)}
                  />
                )}
                {active && !revoke.available && <Text style={base.faint}>{revoke.reason}</Text>}
              </SettingRow>
            );
          })
        )}
      </SettingsSection>
      <MobileButton label={sessions === null ? 'Load sessions' : 'Reload sessions'} kind="secondary" busy={loading} onPress={load} />
      <MobileErrorNote error={error} />
      {notice !== null && (
        <Text style={[base.dim, { color: mobilePalette.positive }]} accessibilityRole="alert">
          {notice}
        </Text>
      )}
      <Sheet
        open={target !== null}
        title="Revoke this session?"
        onClose={() => setTarget(null)}
        dismissable={!revoking}
        bottomInset={bottomInset}
        footer={
          <MobileButtonGroup>
            <MobileButton
              label="Revoke session"
              busy={revoking}
              onPress={() => {
                if (target === null) return;
                setRevoking(true);
                host.controller
                  .revokeSession(target.localPublicKey)
                  .then((which) => {
                    setTarget(null);
                    if (which === 'other-session') {
                      setNotice('Session revoked. Apps using it can no longer reach your node.');
                      load();
                    }
                  })
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setRevoking(false));
              }}
            />
            <MobileButton label="Cancel" kind="secondary" disabled={revoking} onPress={() => setTarget(null)} />
          </MobileButtonGroup>
        }
      >
        <Text style={base.dim}>
          {target?.state === 'in-use'
            ? 'If this is the session this phone is using, the app disconnects at once and you will need a new pairing phrase to connect again.'
            : 'Any app paired with this session will no longer be able to reach your node.'}{' '}
          This cannot be undone.
        </Text>
      </Sheet>
    </View>
  );
}

// ——— Wallet management ———

export function WalletManagementScreen({ host }: { host: WalletHost }): ReactNode {
  const { preferences, store } = usePreferences();
  const platform = usePlatformServices();
  const caps = walletCapabilities(host);
  const current = preferences.walletNames[host.kind];
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmSwitchNode, setConfirmSwitchNode] = useState(false);

  const saveName = (name: string | null): void => {
    const names = { ...preferences.walletNames };
    if (name === null) {
      delete names[host.kind];
    } else {
      const checked = validateWalletName(name);
      if (!checked.ok) {
        setError(checked.message);
        return;
      }
      names[host.kind] = checked.value;
    }
    store
      .set({ walletNames: names })
      .then(() => {
        setRenaming(false);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <MobileScreen>
      <SubHeader host={host} route="walletManage" />
      <SettingsSection title="This wallet">
        <SettingRow label="Name" value={current ?? defaultWalletName(host)} description={current === undefined ? 'Default name' : undefined}>
          <MobileButton
            label="Rename wallet"
            kind="secondary"
            compact
            onPress={() => {
              setDraft(current ?? '');
              setError(null);
              setRenaming(true);
            }}
          />
        </SettingRow>
        <SettingRow label="Type" description={walletTypeLabel(host)} />
        <SettingRow label="Network" value={host.network} />
        <SettingRow label="Accounts" description="Each wallet has one account; separate accounts aren't supported yet." />
      </SettingsSection>

      <SettingsSection title="Wallet types">
        <SettingRow
          label="Everyday wallet (Wavelength)"
          badge={host.kind === 'wavelength' ? { label: 'This wallet', tone: 'positive' } : undefined}
          description="Keys on this phone, protected by a 12-word recovery phrase. Funds sit in an Ark with an operator; Lightning goes through a swap service. No channels to manage."
        />
        <SettingRow
          label="Your node (remote LND)"
          badge={host.kind === 'remote-lnd' ? { label: 'This wallet', tone: 'positive' } : undefined}
          description="Keys and funds stay on your own LND node; this phone connects to it over Lightning Node Connect with a pairing phrase. Channels, Loop and backups are managed on the node."
        />
        <SettingRow
          label="Never mixed"
          description="Each type has its own recovery model. An everyday wallet's phrase cannot restore a node, and a node seed is refused by the everyday wallet."
        />
      </SettingsSection>

      <CapabilitySummary capabilities={caps} features={WALLET_SUMMARY_FEATURES[host.kind]} />

      <SettingsSection title="Add or switch">
        {host.kind === 'wavelength' ? (
          <>
            <SettingRow
              label="Create or restore another wallet"
              value="Not available"
              description="This app holds one everyday wallet per install, and creating or restoring over the current one isn't supported yet. To restore this wallet elsewhere, see Backup."
            />
            <SettingRow
              label="Connect your own node"
              value="Not available"
              description="The wallet type is chosen when the app starts. Switching from the everyday wallet to a node connection inside the app isn't available yet."
            />
          </>
        ) : (
          <>
            <SettingRow
              label="Connect a different node"
              description="Ends this connection and opens pairing, where you enter a pairing phrase from the other node."
            >
              <MobileButton label="Connect a different node" kind="secondary" compact onPress={() => setConfirmSwitchNode(true)} />
            </SettingRow>
            <SettingRow
              label="Create or restore a wallet"
              value="Not available"
              description={caps.features.createWallet.available ? undefined : caps.features.createWallet.reason}
            />
          </>
        )}
        <SettingRow
          label="Switch between wallets"
          value="Not available"
          description="The app runs one wallet at a time, chosen when it starts. Keeping several wallets and switching between them isn't built yet."
        />
      </SettingsSection>
      <PreferencesStatus />

      <Sheet
        open={renaming}
        title="Rename wallet"
        onClose={() => setRenaming(false)}
        bottomInset={platform.bottomInset}
        footer={
          <MobileButtonGroup>
            <MobileButton label="Save name" onPress={() => saveName(draft)} />
            {current !== undefined && (
              <MobileButton label="Use default name" kind="secondary" onPress={() => saveName(null)} />
            )}
            <MobileButton label="Cancel" kind="ghost" onPress={() => setRenaming(false)} />
          </MobileButtonGroup>
        }
      >
        <SettingInput
          label="Wallet name"
          value={draft}
          onChangeText={setDraft}
          maxLength={WALLET_NAME_MAX_LENGTH}
          hint={`Up to ${WALLET_NAME_MAX_LENGTH} characters. Shown only on this device.`}
        />
        <MobileErrorNote error={error} />
      </Sheet>

      {host.kind === 'remote-lnd' && (
        <Sheet
          open={confirmSwitchNode}
          title="Connect a different node?"
          onClose={() => setConfirmSwitchNode(false)}
          bottomInset={platform.bottomInset}
          footer={
            <MobileButtonGroup>
              <MobileButton
                label="Disconnect and pair"
                onPress={() => {
                  setConfirmSwitchNode(false);
                  void host.controller.disconnect();
                }}
              />
              <MobileButton label="Cancel" kind="secondary" onPress={() => setConfirmSwitchNode(false)} />
            </MobileButtonGroup>
          }
        >
          <Text style={base.dim}>
            This phone disconnects from {host.state.node?.alias ?? 'your node'}. Nothing changes on the
            node. You'll need a pairing phrase to connect to any node, including this one.
          </Text>
        </Sheet>
      )}
    </MobileScreen>
  );
}

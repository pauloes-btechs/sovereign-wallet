/**
 * Everyday-wallet (Mode A) "How this wallet works" screen and the shared
 * capability summary. Home and Activity live in `ui/home/` and
 * `ui/activity/`, Send and Receive in `ui/send/` and `ui/receive/`, the
 * Wallet tab in `ui/wallet/`.
 * Everything shown is derived from live controller state and
 * `controller.walletCapabilities()` — no hardcoded parity.
 */

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  describeDependencyKind,
  describeRequiredFor,
  describeSeedType,
  describeUnilateralExit,
  mechanismLabel,
} from '@sovereign/ui/copy';
import type { ModeAController } from '../flows/modeAController.js';
import type { FeatureId, MobileWalletCapabilities } from '../flows/capabilities.js';
import {
  MobileBadge,
  MobileHeader,
  MobileLabelRow,
  MobilePanel,
  MobileScreen,
  MobileWarningBand,
  mobilePalette,
  styles as baseStyles,
} from './Primitives.js';

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
      <MobileHeader title="How this wallet works" onBack={() => controller.goBack()} />
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

// ——— Capability summary (Wallet tab → Wallet management, ui/wallet) ———

/** One row per feature: available (with its note) or not (with the reason). */
export function CapabilitySummary({
  capabilities,
  features,
}: {
  capabilities: MobileWalletCapabilities;
  features: ReadonlyArray<{ id: FeatureId; label: string }>;
}): ReactNode {
  return (
    <MobilePanel title="What this wallet can do here">
      {features.map(({ id, label }, index) => {
        const status = capabilities.features[id];
        return (
          <View key={id} style={[styles.featureRow, index > 0 ? styles.activityRowDivider : null]}>
            <View style={styles.rowBetween}>
              <Text style={styles.value}>{label}</Text>
              <MobileBadge
                label={status.available ? 'Available' : 'Not available'}
                tone={status.available ? 'positive' : 'neutral'}
              />
            </View>
            {status.available ? (
              status.note !== undefined && <Text style={styles.faint}>{status.note}</Text>
            ) : (
              <Text style={styles.faint}>{status.reason}</Text>
            )}
          </View>
        );
      })}
    </MobilePanel>
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
    featureRow: { gap: 4, paddingVertical: 8 },
  }),
};

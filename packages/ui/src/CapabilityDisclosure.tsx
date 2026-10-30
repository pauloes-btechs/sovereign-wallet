import type { WalletCapabilities } from '@sovereign/wallet-core';

import {
  describeAssetSupport,
  describeSeedType,
  describeUnilateralExit,
  mechanismLabel,
} from './copy.js';
import { Card } from './Card.js';
import { OperatorDependencyPanel } from './OperatorDependencyPanel.js';

export interface CapabilityDisclosureProps {
  /** The active provider's declared capabilities — rendered, never inferred. */
  capabilities: Readonly<WalletCapabilities>;
  /** Seed types this provider accepts (disjoint across providers). */
  seedCompatibility?: readonly string[];
  className?: string;
}

/**
 * Capability disclosure panel: renders exactly what the active provider
 * declares. Every Lightning mention names its mechanism ("Lightning via swap
 * service" in Mode A); operator dependencies render verbatim beneath.
 */
export function CapabilityDisclosure({
  capabilities,
  seedCompatibility,
  className,
}: CapabilityDisclosureProps) {
  const lightning =
    capabilities.lightningSend && capabilities.lightningReceive
      ? `Supported — ${mechanismLabel(capabilities.lightningMechanism)}`
      : capabilities.lightningSend
        ? `Sending only — ${mechanismLabel(capabilities.lightningMechanism)}`
        : capabilities.lightningReceive
          ? `Receiving only — ${mechanismLabel(capabilities.lightningMechanism)}`
          : 'Not supported in this mode';
  const onchain =
    capabilities.onchainSend && capabilities.onchainReceive
      ? 'Send & receive'
      : capabilities.onchainSend
        ? 'Send only'
        : capabilities.onchainReceive
          ? 'Receive only'
          : 'Not supported in this mode';

  return (
    <Card title="What this wallet mode does" className={className}>
      <div className="sovl-capability-rows" data-testid="capability-rows">
        <div className="sovl-capability-row">
          <span className="sovl-capability-label">Lightning payments</span>
          <span className="sovl-capability-value" data-testid="lightning-mechanism">
            {lightning}
          </span>
        </div>
        <div className="sovl-capability-row">
          <span className="sovl-capability-label">On-chain Bitcoin</span>
          <span className="sovl-capability-value">{onchain}</span>
        </div>
        <div className="sovl-capability-row">
          <span className="sovl-capability-label">Taproot assets</span>
          <span className="sovl-capability-value">
            {describeAssetSupport(capabilities.assets)}
          </span>
        </div>
        <div className="sovl-capability-row">
          <span className="sovl-capability-label">Exit to on-chain</span>
          <span className="sovl-capability-value">
            {describeUnilateralExit(capabilities.unilateralExit)}
          </span>
        </div>
        <div className="sovl-capability-row">
          <span className="sovl-capability-label">Recovery</span>
          <span className="sovl-capability-value">
            {describeSeedType(capabilities.recoveryModel)}
            {seedCompatibility
              ? seedCompatibility
                  .filter((s) => s !== capabilities.recoveryModel)
                  .map((s) => `, or ${s}`)
                  .join('')
              : ''}
          </span>
        </div>
      </div>
      <OperatorDependencyPanel dependencies={capabilities.operatorDependencies} />
    </Card>
  );
}

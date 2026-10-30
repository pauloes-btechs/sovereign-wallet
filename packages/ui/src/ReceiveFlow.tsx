import { mechanismLabel } from './copy.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { Card } from './Card.js';

export type ReceiveTab = 'onchain' | 'lightning';

export interface ReceiveFlowProps {
  /** Declared Lightning mechanism — copy always names it. */
  lightningMechanism: 'channels' | 'swaps';
  activeTab: ReceiveTab;
  onTabChange: (tab: ReceiveTab) => void;
  /** On-chain address to display; null until the parent generates one. */
  onchainAddress: string | null;
  /** BOLT11/LN invoice to display; null until the parent generates one. */
  invoice: string | null;
  /** Mode A: the swap server's availability gates Lightning receiving. */
  swapServiceReachable?: boolean;
  /** The swap service's fee for the incoming payment, shown before confirming. */
  swapFeeSat?: bigint | null;
  onGenerateAddress?: (() => void) | null;
  onGenerateInvoice?: (() => void) | null;
  className?: string;
}

/**
 * Everyday-mode Receive flow: on-chain address and Lightning invoice tabs.
 * The Lightning tab names the mechanism verbatim from the declared
 * capabilities ("Lightning via swap service" in Mode A) and surfaces swap
 * availability as a first-class state.
 */
export function ReceiveFlow({
  lightningMechanism,
  activeTab,
  onTabChange,
  onchainAddress,
  invoice,
  swapServiceReachable = true,
  swapFeeSat = null,
  onGenerateAddress,
  onGenerateInvoice,
  className,
}: ReceiveFlowProps) {
  const label = mechanismLabel(lightningMechanism);

  return (
    <Card title="Receive" className={className}>
      <div className="sovl-tabs" role="tablist" aria-label="Receive method">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'onchain'}
          className={activeTab === 'onchain' ? 'sovl-tab sovl-tab--active' : 'sovl-tab'}
          onClick={() => onTabChange('onchain')}
        >
          On-chain
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'lightning'}
          className={activeTab === 'lightning' ? 'sovl-tab sovl-tab--active' : 'sovl-tab'}
          onClick={() => onTabChange('lightning')}
        >
          Lightning
        </button>
      </div>

      {activeTab === 'onchain' ? (
        <div>
          {onchainAddress ? (
            <div>
              <p className="sovl-hint" style={{ margin: '0 0 8px' }}>
                Share this address to receive Bitcoin on-chain.
              </p>
              <div className="sovl-mono-value" data-testid="onchain-address">
                {onchainAddress}
              </div>
            </div>
          ) : (
            <div className="sovl-notice-actions">
              {onGenerateAddress ? (
                <Button onClick={onGenerateAddress}>Generate address</Button>
              ) : null}
            </div>
          )}
        </div>
      ) : (
        <div>
          <p style={{ margin: '0 0 10px' }}>
            <span className="sovl-mechanism-tag" data-testid="lightning-mechanism-tag">
              {label}
            </span>
          </p>
          {!swapServiceReachable ? (
            <div
              className="sovl-notice sovl-notice--warning"
              role="status"
              style={{ marginBottom: '14px' }}
            >
              <p className="sovl-notice-title">Swap service unreachable</p>
              <p className="sovl-notice-body">
                Lightning receive is paused until the swap service is reachable
                again. On-chain receiving is unaffected.
              </p>
            </div>
          ) : invoice ? (
            <div>
              <p className="sovl-hint" style={{ margin: '0 0 8px' }}>
                Share this invoice to receive over {label.toLowerCase()}.
              </p>
              <div className="sovl-mono-value" data-testid="lightning-invoice">
                {invoice}
              </div>
              {swapFeeSat !== null ? (
                <div className="sovl-fee-line">
                  <span className="sovl-fee-line-label">Swap service fee</span>
                  <Badge>{swapFeeSat.toLocaleString('en-US')} sats</Badge>
                </div>
              ) : null}
            </div>
          ) : (
            <div>
              <p className="sovl-hint" style={{ margin: '0 0 8px' }}>
                The swap service's fee is shown before you confirm the incoming
                payment.
              </p>
              <div className="sovl-notice-actions">
                {onGenerateInvoice ? <Button onClick={onGenerateInvoice}>New invoice</Button> : null}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

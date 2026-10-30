import type { OperatorDependency } from '@sovereign/wallet-core';

import { describeDependencyKind, describeRequiredFor } from './copy.js';
import { Card } from './Card.js';

export interface OperatorDependencyPanelProps {
  /** Declared dependencies, rendered verbatim — never paraphrased or inferred. */
  dependencies: readonly OperatorDependency[];
  className?: string;
}

/**
 * Operator-dependency disclosure: every third party this wallet mode cannot
 * function without, what it is required for, and the declared disclosure text
 * shown verbatim (spec: no paraphrasing).
 */
export function OperatorDependencyPanel({ dependencies, className }: OperatorDependencyPanelProps) {
  return (
    <Card title="What this wallet depends on" className={className}>
      {dependencies.length === 0 ? (
        <p className="sovl-hint" style={{ margin: 0 }} data-testid="no-dependencies">
          No third-party operators. This wallet mode is fully self-hosted.
        </p>
      ) : (
        <div data-testid="dependency-list">
          {dependencies.map((dep) => (
            <div className="sovl-dependency" key={dep.kind} data-testid="operator-dependency">
              <div className="sovl-dependency-head">
                <span className="sovl-dependency-kind">{describeDependencyKind(dep.kind)}</span>
                <span className="sovl-chip-row">
                  {dep.requiredFor.map((op) => (
                    <span className="sovl-chip" key={op}>
                      {describeRequiredFor(op)}
                    </span>
                  ))}
                </span>
              </div>
              <p className="sovl-dependency-disclosure">{dep.disclosure}</p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

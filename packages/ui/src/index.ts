/**
 * @sovereign/ui — everyday-mode (Wavelength) presentational components.
 *
 * House rules:
 * - Components are isolated and driven entirely by props: no API calls, no
 *   global state, no effects, no context reads in component bodies.
 * - Copy renders what the provider DECLARES — the capability disclosure is
 *   the single source for mechanism and dependency wording.
 * - The word "channel" never appears in Mode A copy; Lightning is always
 *   labeled via `mechanismLabel` ("Lightning via swap service").
 */

export * from './copy.js';
export * from './totals.js';
export * from './Amount.js';
export * from './Badge.js';
export * from './Button.js';
export * from './Card.js';
export * from './TextField.js';
export * from './VtxoStateNotice.js';
export * from './BalanceSummary.js';
export * from './SendFlow.js';
export * from './ReceiveFlow.js';
export * from './BackupConfirmation.js';
export * from './RecoveryFlow.js';
export * from './OperatorDependencyPanel.js';
export * from './CapabilityDisclosure.js';

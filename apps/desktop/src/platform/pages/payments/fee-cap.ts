/** Default Lightning routing-fee cap: 0.5% of the amount, at least 10 sats. */
export function defaultFeeCap(amountSat: number): number {
  return Math.max(10, Math.ceil(amountSat * 0.005));
}

/**
 * The fee-cap field's text. Until the user types a cap (`input` null) it
 * follows the amount, so a zero-amount invoice gets 0.5% of what the user
 * enters, not the 10-sat floor computed at decode time.
 */
export function feeCapText(input: string | null, amountSat: number): string {
  return input ?? String(defaultFeeCap(amountSat));
}

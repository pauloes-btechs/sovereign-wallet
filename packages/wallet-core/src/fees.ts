/** The quoted fee is above the user's fee limit; raised at authorization, before anything moves. */
export class FeeExceedsBudgetError extends Error {
  constructor(
    readonly feeSat: bigint,
    readonly maxFeeSat: number,
  ) {
    super(`Estimated fee of ${feeSat} sats exceeds the spend policy budget of ${maxFeeSat} sats`);
    this.name = 'FeeExceedsBudgetError';
  }
}

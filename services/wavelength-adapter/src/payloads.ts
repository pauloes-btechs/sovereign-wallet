/**
 * Intent payloads for the payment kinds this adapter dispatches. All shapes
 * are JSON-serializable — intents are persisted as JSON before dispatch.
 *
 * The stored quote is the FULL PrepareSendResult from the authorization-time
 * prepareSend: dispatch replays the exact approved quote (its sendIntentId is
 * single-use), never a re-quote.
 */

import type { PrepareSendResult } from './sdk/index.js';

/** Lightning send payload. */
export interface LightningSendPayload {
  readonly invoice: string;
  /** v1 requires an amount-bearing BOLT-11 invoice — this is a display hint only. */
  readonly amountSat?: number;
  readonly note?: string;
  /** The approved quote stored at authorization time. */
  readonly quote?: PrepareSendResult;
}

/** On-chain send payload. */
export interface OnchainSendPayload {
  readonly onchainAddress: string;
  readonly amountSat?: number;
  readonly sweepAll?: boolean;
  readonly note?: string;
  /** The approved quote stored at authorization time. */
  readonly quote?: PrepareSendResult;
}

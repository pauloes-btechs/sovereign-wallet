/**
 * Re-exports the protobuf-ts clients generated from the LND protos pinned to
 * litd v0.17.8 (see protos/README.md). Never hand-edit src/generated.
 */
export * from './generated/lightning';
export * from './generated/lightning.client';
export * from './generated/walletunlocker';
export * from './generated/walletunlocker.client';
export * from './generated/router';
export * from './generated/router.client';
export * from './generated/faraday';
export * from './generated/faraday.client';
// lit-sessions (litrpc): its MacaroonPermission collides with lnrpc's, so the
// type surface is explicit — everything except the colliding name, which is
// re-exported with a Lit prefix.
export {
  AddSessionRequest,
  AddSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  RevokeSessionRequest,
  RevokeSessionResponse,
  Session,
  MacaroonRecipe,
  RulesMap,
  RuleValue,
  SessionType,
  SessionState,
} from './generated/lit-sessions';
export { MacaroonPermission as LitMacaroonPermission } from './generated/lit-sessions';
export * from './generated/lit-sessions.client';
// routerrpc (LND v0.21.5-beta.rc1): payment dispatch (SendPaymentV2 etc.).
// Its types collide with lnrpc's on several names (Payment, SendPayment…),
// so the type surface is explicit — only the Router service client and the
// request/response types we consume.
export {
  SendPaymentRequest,
  SendToRouteRequest,
  TrackPaymentRequest,
} from './generated/router';
export { RouterClient } from './generated/router.client';
export * from './generated/router.client';

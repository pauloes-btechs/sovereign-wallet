/**
 * Re-exports the protobuf-ts clients generated from the protos pinned to
 * litd v0.17.8 (see protos/README.md): LND v0.21.5-beta.rc1 + the tapd
 * v0.8.6 tap surface. Never hand-edit src/generated.
 *
 * LND protos are flat-re-exported (the historical surface). The tapd protos
 * collide with LNRpc names on purpose-shared messages (GetInfoRequest,
 * OutPoint) and are therefore exported under namespaces — always use them
 * via `tapdAssets.*` / `tapdMint.*` / `tapdCommon.*` instead of importing
 * their types flat.
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
export * as tapdCommon from './generated/tapcommon';
export * as tapdAssets from './generated/taprootassets';
export * as tapdMint from './generated/mint';
// Client classes keep their own namespaces (collision policy above).
export * as tapdAssetsClient from './generated/taprootassets.client';
export * as tapdMintClient from './generated/mint.client';

/**
 * Loop and Pool surfaces are namespaced, not star-exported: they redefine
 * several LND message names (Utxo, HopHint, StopDaemonRequest, ...) and
 * blanket re-export would create ambiguous exports. Consume as
 * `Loop.SwapClientClient` / `Pool.TraderClient` and friends.
 */
export * as Loop from './generated/loop';
export * as LoopClient from './generated/loop.client';
export * as LoopCommon from './generated/common';
export * as Pool from './generated/pool';
export * as PoolClient from './generated/pool.client';
export * as PoolAuctioneer from './generated/auctioneer';
export * as PoolAuctioneerClient from './generated/auctioneer.client';

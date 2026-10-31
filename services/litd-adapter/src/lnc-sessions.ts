/**
 * LNC session administration (litd `litrpc.Sessions` surface).
 *
 * Mobile Mode B never embeds LND — it connects to the user's own litd through
 * Lightning Node Connect. This module is the admin side of that flow, run
 * wherever the user's node is managed (the desktop app / node operator):
 * create a session, hand the 10-word pairing phrase to the mobile client,
 * revoke it later. The pairing side (PAKE + Noise through the mailbox) lives
 * in the client runtime (@lightninglabs/lnc-rn on mobile, lnc-web WASM in
 * Node-based e2e).
 *
 * Transport: litd's TLS proxy (`httpslisten`) with a disk macaroon — the
 * super macaroon (bake-super-macaroon) or an admin-baked equivalent.
 *
 * Verified against litd v0.17.8 sources (session/server.go, litrpc protos):
 * - AddSession requires `expiry_timestamp_seconds` in the future — the zero
 *   value is rejected ("expiry must be in the future"), there is no
 *   "never expires" sentinel.
 * - The pairing phrase is returned as `session.pairing_secret_mnemonic`,
 *   always 10 words (mailbox.NumPassphraseWords).
 * - Sessions are identified by their local public key for revocation.
 */
import {
  SessionType as LitSessionType,
  SessionsClient,
} from '@sovereign/litd-proto';
import type { ListSessionsRequest, RevokeSessionRequest } from '@sovereign/litd-proto';
import type { LitdConnectionOptions } from './client.js';
import { createLitdTransport } from './client.js';
import type { MacaroonPermissionSpec } from './macaroons.js';
import { bytesToHex, hexToBytes } from './bytes.js';

export type LncSessionType = 'readonly' | 'admin' | 'custom';

export interface CreateLncSessionOptions {
  /** User-facing label, e.g. "Sovereign mobile (Pixel 8)". */
  readonly label: string;
  readonly sessionType: LncSessionType;
  /** host:port of the mailbox (aperture) the session uses. */
  readonly mailboxServerAddr: string;
  /**
   * Dev-mailbox mode: TLS with certificate verification disabled. Required
   * for self-signed local/regtest mailboxes; false for production mailboxes
   * (mailbox.terminal.lightning.today).
   */
  readonly devServer: boolean;
  /** litd rejects anything at-or-before now ("expiry must be in the future"). */
  readonly expiresAt: Date;
  /** Required for sessionType 'custom': the macaroon permission list. */
  readonly customPermissions?: readonly MacaroonPermissionSpec[];
}

export interface LncSessionHandle {
  readonly localPublicKeyHex: string;
  /** Exactly 10 words — the mobile pairing phrase. */
  readonly pairingPhrase: string;
  readonly label: string;
  readonly expiry: Date;
  readonly revoked: boolean;
}

/** Pure: litd SessionType enum value for our scoped session kinds. */
export function litSessionType(type: LncSessionType): LitSessionType {
  switch (type) {
    case 'readonly':
      return LitSessionType.TYPE_MACAROON_READONLY;
    case 'admin':
      return LitSessionType.TYPE_MACAROON_ADMIN;
    case 'custom':
      return LitSessionType.TYPE_MACAROON_CUSTOM;
  }
}

/** Pure: litd refuses to create a session whose expiry is not in the future. */
export function assertFutureExpiry(now: Date, expiresAt: Date): void {
  if (!(expiresAt.getTime() > now.getTime())) {
    throw new Error(
      `LNC session expiry must be in the future (got ${expiresAt.toISOString()})`,
    );
  }
}

const PAIRING_PHRASE_WORDS = 10;

/** Pure: the pairing phrase must be exactly 10 words (mailbox.NumPassphraseWords). */
export function assertTenWordPhrase(phrase: string): void {
  const words = phrase.split(' ');
  if (words.length !== PAIRING_PHRASE_WORDS || words.some((w) => w.length === 0)) {
    throw new Error(
      `expected a ${PAIRING_PHRASE_WORDS}-word pairing phrase, got ${words.length} words`,
    );
  }
}

export class LncSessionManager {
  private readonly client: Promise<SessionsClient>;

  constructor(connection: LitdConnectionOptions) {
    // Transport creation is async (reads the TLS cert + macaroon from disk);
    // every call awaits it — cheap for an admin surface.
    this.client = createLitdTransport(connection).then((t) => new SessionsClient(t));
  }

  async createSession(options: CreateLncSessionOptions): Promise<LncSessionHandle> {
    assertFutureExpiry(new Date(), options.expiresAt);
    if (options.sessionType === 'custom' && (options.customPermissions?.length ?? 0) === 0) {
      throw new Error("sessionType 'custom' requires customPermissions");
    }

    const response = await (await this.client)
      .addSession({
        label: options.label,
        sessionType: litSessionType(options.sessionType),
        expiryTimestampSeconds: String(Math.floor(options.expiresAt.getTime() / 1000)),
        mailboxServerAddr: options.mailboxServerAddr,
        devServer: options.devServer,
        macaroonCustomPermissions: options.customPermissions
          ? options.customPermissions.map((p) => ({ entity: p.entity, action: p.action }))
          : [],
        accountId: '',
      })
      .response;

    const session = response.session;
    if (!session) {
      throw new Error('litd AddSession returned no session');
    }
    const phrase = session.pairingSecretMnemonic;
    assertTenWordPhrase(phrase);

    return {
      localPublicKeyHex: bytesToHex(session.localPublicKey),
      pairingPhrase: phrase,
      label: session.label,
      expiry: new Date(Number(session.expiryTimestampSeconds) * 1000),
      revoked: session.revokedAt !== '0' && session.revokedAt !== '',
    };
  }

  async revokeSession(localPublicKeyHex: string): Promise<void> {
    await (await this.client)
      .revokeSession({
        localPublicKey: hexToBytes(localPublicKeyHex),
      } as RevokeSessionRequest)
      .response;
  }

  async listSessions(): Promise<readonly LncSessionHandle[]> {
    const response = await (await this.client).listSessions({} as ListSessionsRequest).response;
    return (response.sessions ?? []).map((session) => ({
      localPublicKeyHex: bytesToHex(session.localPublicKey),
      pairingPhrase: session.pairingSecretMnemonic,
      label: session.label,
      expiry: new Date(Number(session.expiryTimestampSeconds) * 1000),
      revoked: session.revokedAt !== '0' && session.revokedAt !== '',
    }));
  }
}

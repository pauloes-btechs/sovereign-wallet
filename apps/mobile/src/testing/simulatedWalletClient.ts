/**
 * MobileFlowSimulatedClient — test-only subclass of the harness's
 * SimulatedWavelengthClient that ALSO simulates the wallet lifecycle the
 * base class throws on (createWallet / unlockWallet), because the base sim
 * only covers post-creation daemon behavior.
 *
 * Drives the REAL WavelengthProvider, PaymentDispatcher, PaymentEngine, and
 * ModeAController — only the daemon is fake. Word list: the canonical BIP39
 * test vector (valid checksum), NOT a real wallet's phrase.
 */

import { SimulatedWavelengthClient } from '@sovereign/harness-regtest/simulated-client';
import { WavelengthError } from '@sovereign/wavelength-adapter';
import type {
  CreateWalletRequest,
  CreateWalletResult,
  DepositRequest,
  DepositResult,
  PrepareSendResult,
  ReceiveRequest,
  ReceiveResult,
  SendRequest,
  UnlockWalletRequest,
  UnlockWalletResult,
} from '@sovereign/wavelength-adapter';
import { decodeBolt11, invoiceAmountSat, parseOnchainAddress } from '../flows/destination.js';
import { encodeSimulatedBolt11, simHashHex, simSegwitAddress } from './simInvoice.js';

/** Canonical 12-word BIP39 test vector — valid checksum, never funds. */
export const SIM_WORDS: readonly string[] = [
  'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'abandon',
  'abandon', 'abandon', 'abandon', 'abandon', 'abandon', 'about',
];

export interface MobileFlowSimulatedClientOptions {
  /**
   * Where a fresh wallet's phrase comes from. Tests leave it out and get the
   * fixed SIM_WORDS (so they can type known words); the web demo passes a
   * CSPRNG generator so every new wallet shows a different phrase.
   */
  readonly freshMnemonic?: () => string[];
}

export class MobileFlowSimulatedClient extends SimulatedWavelengthClient {
  private readonly phraseSource: () => string[];

  constructor(options: MobileFlowSimulatedClientOptions = {}) {
    super();
    this.phraseSource = options.freshMnemonic ?? (() => [...SIM_WORDS]);
  }

  /** Driver observability: what the wallet layer asked the daemon to do. */
  walletCreated = false;
  restoredFromWords: string[] | null = null;
  recoveryRan = false;
  recoveredVTXOs = 0;

  /**
   * Empty/omitted mnemonic = fresh creation (the daemon generates the seed);
   * a provided mnemonic = restore. Mirrors the SDK's exported contract
   * (`requests.d.ts`: `{ password, mnemonic?, seedPassphrase?, recoverState? }`).
   */
  override async createWallet(req: CreateWalletRequest): Promise<CreateWalletResult> {
    this.walletCreated = true;
    const mnemonic = req.mnemonic !== undefined && req.mnemonic.length > 0 ? [...req.mnemonic] : this.phraseSource();
    if (req.mnemonic !== undefined && req.mnemonic.length > 0) this.restoredFromWords = [...req.mnemonic];
    this.recoveryRan = req.recoverState ?? false;
    this.recoveredVTXOs = this.recoveryRan ? 3 : 0;
    return {
      mnemonic,
      encipheredSeed: 'sim-enciphered-seed',
      identityPubKey: 'sim-identity',
      recoveryRan: req.recoverState ?? false,
      recoveredBoardingAddresses: 0,
      recoveredBoardingUTXOs: 0,
      recoveredVTXOs: this.recoveredVTXOs,
      recoveredOORReceiveScripts: 0,
      recoveredOORRecipientEvents: 0,
    };
  }

  /**
   * The base simulator hands out placeholder strings (`bcrt1q-sim-board-N`,
   * `lnbcrt1-sim-N`). These overrides return well-formed regtest addresses
   * and (unsigned) BOLT11 invoices instead, so the Send parser treats them
   * like real ones, and the receive entry carries the invoice's payment hash
   * the way the daemon's does.
   */
  override async deposit(req?: DepositRequest): Promise<DepositResult> {
    const result = await super.deposit(req);
    return { ...result, address: simSegwitAddress('regtest', result.address) };
  }

  override async receive(req: ReceiveRequest): Promise<ReceiveResult> {
    const result = await super.receive(req);
    const paymentHash = simHashHex(`wavelength-receive-${result.entry.id}`);
    const progress = result.entry.progress;
    if (progress !== undefined) result.entry.progress = { ...progress, paymentHash };
    const invoice = encodeSimulatedBolt11({
      network: 'regtest',
      amountMsat: BigInt(req.amountSat) * 1000n,
      paymentHashHex: paymentHash,
      description: req.memo,
      timestamp: Math.floor(Date.now() / 1000),
    });
    return { ...result, invoice };
  }

  /**
   * Quotes like the SDK: the invoice path reads the amount from the invoice
   * (v1 refuses amountless ones) and unreadable or expired invoices and
   * addresses are refused before anything is quoted.
   */
  override async prepareSend(req: SendRequest): Promise<PrepareSendResult> {
    if ('invoice' in req && req.invoice !== '') {
      const decoded = decodeBolt11(req.invoice);
      if (!decoded.ok) throw new WavelengthError('invalid lightning invoice', 'invalid_argument');
      if (Math.floor(Date.now() / 1000) >= decoded.invoice.expiresAt) {
        throw new WavelengthError('invoice expired', 'invalid_argument');
      }
      const amount = invoiceAmountSat(decoded.invoice);
      if (amount === null) {
        throw new WavelengthError('amountless invoices are not supported: v1 requires an amount-bearing invoice', 'invalid_argument');
      }
      return super.prepareSend({ ...req, amountSat: Number(amount) });
    }
    if ('onchainAddress' in req && !parseOnchainAddress(req.onchainAddress).ok) {
      throw new WavelengthError('invalid on-chain address', 'invalid_argument');
    }
    return super.prepareSend(req);
  }

  override async unlockWallet(_req: UnlockWalletRequest): Promise<UnlockWalletResult> {
    return { identityPubKey: 'sim-identity' };
  }
}

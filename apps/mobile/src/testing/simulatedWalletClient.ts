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
import type {
  CreateWalletRequest,
  CreateWalletResult,
  UnlockWalletRequest,
  UnlockWalletResult,
} from '@sovereign/wavelength-adapter';

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

  override async unlockWallet(_req: UnlockWalletRequest): Promise<UnlockWalletResult> {
    return { identityPubKey: 'sim-identity' };
  }
}

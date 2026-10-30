/**
 * React context owning the desktop Mode A wallet session. One provider
 * instance owns exactly one gateway session; wallet state is POLLED from the
 * daemon (getInfo) every WALLET_POLL_MS and events are honored as edges —
 * the UI renders backend-declared state, never assumptions.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { WavelengthProviderError } from '@sovereign/wavelength-adapter';
import type { WavelengthProvider } from '@sovereign/wavelength-adapter';
import type { BalanceBuckets } from '@sovereign/wallet-core';
import type { PaymentEngine } from '@sovereign/payments';
import {
  connectGatewaySession,
  sessionPhaseFromInfo,
  WALLET_POLL_MS,
  type GatewayBootstrap,
  type WalletSession,
  type WalletSessionState,
} from './session.js';

export interface WalletSessionValue {
  state: WalletSessionState;
  /** Live balance buckets once a wallet exists; null until 'ready'. */
  balance: BalanceBuckets | null;
  provider: WavelengthProvider | null;
  /** Crash-safe payment engine (intents persist before dispatch). */
  engine: PaymentEngine | null;
  /** One-shot connect error (transport/gateway), separate from phase machine. */
  connectError: string | null;
  createWallet(password: string): Promise<readonly string[]>;
  /** User has written the words down — clears the pending-backup override. */
  backupAcknowledged(): void;
  unlockWallet(password: string): Promise<void>;
  refresh(): Promise<void>;
  receiveLightningInvoice(amountSat: number, memo?: string): Promise<string>;
  onchainDepositAddress(amountSatHint?: number): Promise<string>;
}

const WalletSessionContext = createContext<WalletSessionValue | null>(null);

export function useWalletSession(): WalletSessionValue {
  const value = useContext(WalletSessionContext);
  if (!value) throw new Error('useWalletSession outside WalletSessionProvider');
  return value;
}

export interface WalletSessionProviderProps {
  bootstrap: GatewayBootstrap | null;
  children: ReactNode;
}

export function WalletSessionProvider({ bootstrap, children }: WalletSessionProviderProps): ReactNode {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [state, setState] = useState<WalletSessionState>({ phase: 'connecting' });
  const [balance, setBalance] = useState<BalanceBuckets | null>(null);
  const pendingMnemonic = useRef<readonly string[] | null>(null);

  // ——— connect on bootstrap, dispose on change/unmount ———
  useEffect(() => {
    if (!bootstrap) return;
    let cancelled = false;
    let active: WalletSession | null = null;
    void connectGatewaySession(bootstrap)
      .then((wired) => {
        if (cancelled) {
          void wired.dispose();
          return;
        }
        active = wired;
        setSession(wired);
        setConnectError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConnectError(err instanceof Error ? err.message : String(err));
        setState({ phase: 'failed', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      setSession(null);
      setBalance(null);
      setState({ phase: 'connecting' });
      void active?.dispose().catch(() => {
        /* dispose failure at teardown is surfaced by the next boot */
      });
    };
  }, [bootstrap]);

  // ——— poll wallet state + balance ———
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const info = await session.provider.walletInfo();
        if (cancelled) return;
        setState(sessionPhaseFromInfo(info, pendingMnemonic.current));
        if (info.walletState === 'ready' || info.walletState === 'syncing') {
          setBalance(await session.provider.balanceBuckets());
        } else {
          setBalance(null);
        }
      } catch {
        // A failed poll (daemon restarting between boots) keeps the last
        // known state; the sidecar phase surface shows transport health.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), WALLET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session]);

  const createWallet = useCallback(
    async (password: string): Promise<readonly string[]> => {
      if (!session) throw new WavelengthProviderError('session not connected', 'not-started');
      const result = await session.provider.createWallet({ password });
      pendingMnemonic.current = result.mnemonic;
      setState({ phase: 'backup-confirm', mnemonic: result.mnemonic });
      return result.mnemonic;
    },
    [session],
  );

  const backupAcknowledged = useCallback((): void => {
    pendingMnemonic.current = null;
  }, []);

  const unlockWallet = useCallback(
    async (password: string): Promise<void> => {
      if (!session) throw new WavelengthProviderError('session not connected', 'not-started');
      await session.provider.unlockWallet(password);
      const info = await session.provider.walletInfo();
      setState(sessionPhaseFromInfo(info, pendingMnemonic.current));
    },
    [session],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!session) return;
    const info = await session.provider.walletInfo();
    setState(sessionPhaseFromInfo(info, pendingMnemonic.current));
    if (info.walletState === 'ready' || info.walletState === 'syncing') {
      setBalance(await session.provider.balanceBuckets());
    }
  }, [session]);

  const receiveLightningInvoice = useCallback(
    async (amountSat: number, memo?: string): Promise<string> => {
      if (!session) throw new WavelengthProviderError('session not connected', 'not-started');
      return session.provider.receiveLightning(amountSat, memo);
    },
    [session],
  );

  const onchainDepositAddress = useCallback(
    async (amountSatHint?: number): Promise<string> => {
      if (!session) throw new WavelengthProviderError('session not connected', 'not-started');
      return session.provider.depositOnchain(amountSatHint);
    },
    [session],
  );

  const value = useMemo<WalletSessionValue>(
    () => ({
      state,
      balance,
      provider: session?.provider ?? null,
      engine: session?.engine ?? null,
      connectError,
      createWallet,
      backupAcknowledged,
      unlockWallet,
      refresh,
      receiveLightningInvoice,
      onchainDepositAddress,
    }),
    [
      state,
      balance,
      session,
      connectError,
      createWallet,
      backupAcknowledged,
      unlockWallet,
      refresh,
      receiveLightningInvoice,
      onchainDepositAddress,
    ],
  );

  return <WalletSessionContext.Provider value={value}>{children}</WalletSessionContext.Provider>;
}

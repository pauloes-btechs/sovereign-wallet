/**
 * Wallet tab routes. The root ('wallet') is the tab's root; the others are
 * pushed onto the Wallet stack. Both controllers list the same strings in
 * their route unions (`ModeARoute`, `ModeBRoute`).
 */

export const WALLET_SUB_ROUTES = [
  'walletGeneral',
  'walletPayments',
  'walletSecurity',
  'walletBackup',
  'walletPrivacy',
  'walletNetwork',
  'walletManage',
] as const;

export type WalletSubRoute = (typeof WALLET_SUB_ROUTES)[number];
export type WalletRoute = 'wallet' | WalletSubRoute;

export function isWalletRoute(route: string): route is WalletRoute {
  return route === 'wallet' || WALLET_SUB_ROUTES.some((r) => r === route);
}

/** Screen titles — also the rows' labels on the Wallet root. */
export const WALLET_ROUTE_TITLES: Readonly<Record<WalletRoute, string>> = {
  wallet: 'Wallet',
  walletGeneral: 'General',
  walletPayments: 'Payment preferences',
  walletSecurity: 'Security and recovery',
  walletBackup: 'Backup',
  walletPrivacy: 'Privacy',
  walletNetwork: 'Network and connection',
  walletManage: 'Wallet management',
};

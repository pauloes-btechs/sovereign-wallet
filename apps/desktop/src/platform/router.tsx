/**
 * Hash router + the route registry (the app's information architecture).
 * Hash routing keeps deep links working inside the Tauri webview and under
 * the hosted demo's /desktop/ base without server rewrites.
 */
import { lazy, useEffect, useState, type AnchorHTMLAttributes, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';

export type ServiceName = 'loop' | 'pool' | 'taproot-assets' | 'faraday';

export interface RouteDef {
  readonly path: string;
  readonly title: string;
  readonly group: 'Overview' | 'Payments' | 'Liquidity' | 'Assets' | 'Infrastructure' | 'Account';
  readonly icon: string;
  readonly page: LazyExoticComponent<ComponentType>;
  /** litd sub-server the page depends on (nav marks it when not running). */
  readonly requires?: ServiceName;
  /** Extra words for the command palette. */
  readonly keywords?: string;
  /** Hidden from the sidebar (reachable by link / palette). */
  readonly hidden?: boolean;
}

const page = (load: () => Promise<{ default: ComponentType }>) => lazy(load);

export const ROUTES: readonly RouteDef[] = [
  { path: '/', title: 'Dashboard', group: 'Overview', icon: 'dashboard', page: page(() => import('./pages/overview/dashboard.js')), keywords: 'home balances summary' },
  { path: '/activity', title: 'Activity', group: 'Overview', icon: 'activity', page: page(() => import('./pages/overview/activity.js')), keywords: 'transactions history payments invoices' },
  { path: '/accounts', title: 'Accounts & balances', group: 'Overview', icon: 'accounts', page: page(() => import('./pages/overview/accounts.js')), keywords: 'balance wallet funds' },

  { path: '/send', title: 'Send', group: 'Payments', icon: 'send', page: page(() => import('./pages/payments/send.js')), keywords: 'pay invoice withdraw' },
  { path: '/receive', title: 'Receive', group: 'Payments', icon: 'receive', page: page(() => import('./pages/payments/receive.js')), keywords: 'deposit address invoice fund qr' },
  { path: '/transfers', title: 'Transfers & swaps', group: 'Payments', icon: 'swap', page: page(() => import('./pages/payments/transfers.js')), keywords: 'move funds loop swap on-chain lightning' },
  { path: '/requests', title: 'Payment requests', group: 'Payments', icon: 'request', page: page(() => import('./pages/payments/requests.js')), keywords: 'invoices requests' },

  { path: '/liquidity', title: 'Liquidity overview', group: 'Liquidity', icon: 'liquidity', page: page(() => import('./pages/liquidity/overview.js')), keywords: 'inbound outbound capacity' },
  { path: '/loop', title: 'Loop', group: 'Liquidity', icon: 'loop', page: page(() => import('./pages/liquidity/loop.js')), requires: 'loop', keywords: 'loop in loop out swap static address autoloop' },
  { path: '/pool', title: 'Pool', group: 'Liquidity', icon: 'pool', page: page(() => import('./pages/liquidity/pool.js')), requires: 'pool', keywords: 'marketplace lease buy sell inbound sidecar' },
  { path: '/channels', title: 'Channels', group: 'Liquidity', icon: 'channels', page: page(() => import('./pages/liquidity/channels.js')), keywords: 'open close fees policy peers' },
  { path: '/automation', title: 'Automation', group: 'Liquidity', icon: 'automation', page: page(() => import('./pages/liquidity/automation.js')), requires: 'loop', keywords: 'autoloop budget rules' },

  { path: '/assets/bitcoin', title: 'Bitcoin', group: 'Assets', icon: 'bitcoin', page: page(() => import('./pages/assets/bitcoin.js')), keywords: 'btc on-chain utxo' },
  { path: '/assets', title: 'Taproot Assets', group: 'Assets', icon: 'assets', page: page(() => import('./pages/assets/taproot.js')), requires: 'taproot-assets', keywords: 'tapd stablecoin tokens' },
  { path: '/assets/activity', title: 'Asset activity', group: 'Assets', icon: 'activity', page: page(() => import('./pages/assets/activity.js')), requires: 'taproot-assets', keywords: 'asset transfers proofs' },

  { path: '/node', title: 'Node overview', group: 'Infrastructure', icon: 'node', page: page(() => import('./pages/infrastructure/node.js')), keywords: 'lnd status sync services daemon' },
  { path: '/network', title: 'Network & peers', group: 'Infrastructure', icon: 'network', page: page(() => import('./pages/infrastructure/network.js')), keywords: 'peers connections graph' },
  { path: '/routing', title: 'Routing & analytics', group: 'Infrastructure', icon: 'analytics', page: page(() => import('./pages/infrastructure/routing.js')), requires: 'faraday', keywords: 'forwarding fees faraday revenue insights' },
  { path: '/connections', title: 'Connections', group: 'Infrastructure', icon: 'connections', page: page(() => import('./pages/infrastructure/connections.js')), keywords: 'lnc remote node pairing services' },

  { path: '/wallets', title: 'Wallets', group: 'Account', icon: 'wallets', page: page(() => import('./pages/account/wallets.js')), keywords: 'mode everyday advanced' },
  { path: '/security', title: 'Security & recovery', group: 'Account', icon: 'security', page: page(() => import('./pages/account/security.js')), keywords: 'backup scb seed restore lock' },
  { path: '/privacy', title: 'Privacy', group: 'Account', icon: 'privacy', page: page(() => import('./pages/account/privacy.js')), keywords: 'tor egress disclosure' },
  { path: '/settings', title: 'Settings', group: 'Account', icon: 'settings', page: page(() => import('./pages/account/settings.js')), keywords: 'preferences unit denomination' },
  { path: '/developer', title: 'Developer tools', group: 'Account', icon: 'developer', page: page(() => import('./pages/account/developer.js')), keywords: 'api rpc logs diagnostics' },
];

export const GROUPS = ['Overview', 'Payments', 'Liquidity', 'Assets', 'Infrastructure', 'Account'] as const;

function currentPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h === '' ? '/' : h.split('?')[0] ?? '/';
}

export function navigate(path: string): void {
  if (currentPath() !== path) window.location.hash = path;
}

export function useLocation(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

/** Longest registered prefix wins: /loop/out → the Loop route. */
export function matchRoute(path: string): RouteDef {
  let best: RouteDef | undefined;
  for (const r of ROUTES) {
    const hit = r.path === '/' ? path === '/' : path === r.path || path.startsWith(`${r.path}/`);
    if (hit && (best === undefined || r.path.length > best.path.length)) best = r;
  }
  return best ?? (ROUTES[0] as RouteDef);
}

export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a href={`#${to}`} className={className} {...rest}>
      {children}
    </a>
  );
}

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GROUPS, Link, matchRoute, navigate, ROUTES, useLocation, type RouteDef } from './router.js';
import { usePlatform, usePrefs } from './context.js';
import { Badge, Icon, Skeleton } from './ui.js';

/** Quick actions offered by the palette alongside page navigation. */
const ACTIONS: readonly { label: string; to: string; icon: string; keywords: string }[] = [
  { label: 'Send a payment', to: '/send', icon: 'send', keywords: 'pay invoice' },
  { label: 'Receive bitcoin', to: '/receive', icon: 'receive', keywords: 'deposit address' },
  { label: 'Move Lightning funds on-chain (Loop Out)', to: '/loop/out', icon: 'loop', keywords: 'cold storage withdraw' },
  { label: 'Move on-chain funds into Lightning (Loop In)', to: '/loop/in', icon: 'loop', keywords: 'outbound capacity' },
  { label: 'Open a channel', to: '/channels', icon: 'channels', keywords: 'peer' },
];

function NavItem({ route, current }: { route: RouteDef; current: boolean }) {
  const { services } = usePlatform();
  const sub = route.requires === undefined ? undefined : services.data?.subServers?.[route.requires];
  const down = route.requires !== undefined && services.data !== undefined && sub?.running !== true;
  return (
    <Link
      to={route.path}
      className="p-nav-item"
      aria-current={current ? 'page' : undefined}
      data-unavailable={down ? 'true' : undefined}
      title={route.title}
    >
      <Icon name={route.icon} />
      <span className="p-nav-label">{route.title}</span>
      {down ? <span className="p-nav-pill">Offline</span> : null}
    </Link>
  );
}

function Sidebar({ path }: { path: string }) {
  const prefs = usePrefs();
  const active = matchRoute(path);
  return (
    <nav className="p-sidebar" aria-label="Main">
      <div className="p-brand">
        <span className="p-brand-mark">
          <Icon name="bolt" />
        </span>
        <span className="p-brand-name">Sovereign Wallet</span>
      </div>
      <div className="p-nav">
        {GROUPS.map((g) => (
          <div className="p-nav-group" key={g}>
            <div className="p-nav-heading">{g}</div>
            {ROUTES.filter((r) => r.group === g && !r.hidden).map((r) => (
              <NavItem key={r.path} route={r} current={r === active} />
            ))}
          </div>
        ))}
      </div>
      <div className="p-sidebar-foot">
        <button
          type="button"
          className="p-nav-item"
          onClick={() => prefs.set({ sidebarCollapsed: !prefs.sidebarCollapsed })}
          aria-label={prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Icon name={prefs.sidebarCollapsed ? 'expand' : 'collapse'} />
          <span className="p-nav-label">Collapse</span>
        </button>
      </div>
    </nav>
  );
}

function NodeStatus() {
  const { node, services } = usePlatform();
  const info = node.info;
  const network = services.data?.network ?? info?.chains[0]?.network ?? '';
  const synced = info?.syncedToChain === true;
  return (
    <div className="p-row">
      {network ? <Badge tone={network === 'mainnet' ? 'accent' : 'info'} plain>{network}</Badge> : null}
      <Badge tone={synced ? 'positive' : 'warning'}>{synced ? `Synced · block ${info?.blockHeight ?? ''}` : 'Syncing'}</Badge>
    </div>
  );
}

/** Words for known sub-paths; ids are shortened; anything else is title-cased. */
const SEGMENT_LABEL: Record<string, string> = {
  onchain: 'On-chain',
  lightning: 'Lightning',
  out: 'Loop Out',
  in: 'Loop In',
  static: 'Static address',
  autoloop: 'AutoLoop',
  history: 'History',
  buy: 'Buy liquidity',
  sell: 'Sell liquidity',
  sidecar: 'Sidecar',
  mint: 'Mint',
};

export function crumbLabel(seg: string): string {
  const known = SEGMENT_LABEL[seg];
  if (known !== undefined) return known;
  if (/^[0-9a-f]{16,}$/i.test(seg)) return `${seg.slice(0, 8)}…${seg.slice(-4)}`;
  return seg.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function Crumbs({ path }: { path: string }) {
  const route = matchRoute(path);
  const rest = path.slice(route.path === '/' ? 1 : route.path.length).split('/').filter(Boolean);
  return (
    <nav className="p-crumbs" aria-label="Breadcrumb">
      <span>{route.group}</span>
      <Icon name="chevronRight" size={14} />
      {rest.length === 0 ? (
        <span aria-current="page">{route.title}</span>
      ) : (
        <>
          <Link to={route.path}>{route.title}</Link>
          {rest.map((seg, i) => (
            <span key={seg} className="p-row" style={{ gap: 8 }}>
              <Icon name="chevronRight" size={14} />
              <span aria-current={i === rest.length - 1 ? 'page' : undefined}><span className={/^[0-9a-f]{16,}$/i.test(seg) ? 'p-mono' : undefined}>{crumbLabel(seg)}</span></span>
            </span>
          ))}
        </>
      )}
    </nav>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = useMemo(() => {
    const all = [
      ...ACTIONS.map((a) => ({ label: a.label, to: a.to, icon: a.icon, hint: 'Action', hay: `${a.label} ${a.keywords}` })),
      ...ROUTES.map((r) => ({ label: r.title, to: r.path, icon: r.icon, hint: r.group, hay: `${r.title} ${r.group} ${r.keywords ?? ''}` })),
    ];
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((it) => terms.every((t) => it.hay.toLowerCase().includes(t))).slice(0, 12);
  }, [q]);
  const go = (to: string) => {
    navigate(to);
    onClose();
  };
  return (
    <>
      <div className="p-scrim" onClick={onClose} />
      <div className="p-palette" role="dialog" aria-modal="true" aria-label="Search">
        <input
          ref={input}
          value={q}
          placeholder="Search pages and actions"
          aria-label="Search pages and actions"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, items.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            }
            if (e.key === 'Enter' && items[sel]) go(items[sel].to);
          }}
        />
        <ul role="listbox">
          {items.length === 0 ? <li aria-disabled>No matches</li> : null}
          {items.map((it, i) => (
            <li key={`${it.to}-${it.label}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(it.to)}>
              <Icon name={it.icon} />
              {it.label}
              <small>{it.hint}</small>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export function Shell({ children }: { children?: ReactNode }) {
  const path = useLocation();
  const prefs = usePrefs();
  const [palette, setPalette] = useState(false);
  const route = matchRoute(path);
  const Page = route.page;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (!typing && e.key === '/') {
        e.preventDefault();
        setPalette(true);
      } else if (!typing && e.key === '.' ) {
        prefs.set({ hideAmounts: !prefs.hideAmounts });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs]);

  useEffect(() => {
    document.title = `${route.title} · Sovereign Wallet`;
  }, [route]);

  return (
    <div className="p-shell" data-collapsed={prefs.sidebarCollapsed ? 'true' : 'false'}>
      <Sidebar path={path} />
      <div className="p-main">
        <header className="p-topbar">
          <Crumbs path={path} />
          <button type="button" className="p-search-trigger" onClick={() => setPalette(true)}>
            <Icon name="search" />
            Search or jump to…
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-icon"
            onClick={() => prefs.set({ hideAmounts: !prefs.hideAmounts })}
            aria-pressed={prefs.hideAmounts}
            aria-label={prefs.hideAmounts ? 'Show amounts' : 'Hide amounts'}
            title={prefs.hideAmounts ? 'Show amounts (.)' : 'Hide amounts (.)'}
          >
            <Icon name={prefs.hideAmounts ? 'eyeOff' : 'privacy'} />
          </button>
          <NodeStatus />
        </header>
        <main className="p-content" id="main">
          <div className="p-page">
            {children}
            <Suspense fallback={<Skeleton height={28} width={240} />}>
              <Page key={route.path} />
            </Suspense>
          </div>
        </main>
      </div>
      {palette ? <Palette onClose={() => setPalette(false)} /> : null}
    </div>
  );
}

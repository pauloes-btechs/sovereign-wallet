/**
 * Primary navigation model shared by both wallet modes.
 *
 * Five primary tabs (Home, Activity, Send, Receive, Wallet), each with its
 * own push/pop stack. Pure TypeScript and immutable: controllers embed a
 * `NavigationState` in their own state and replace it through these
 * reducers, so navigation is unit-testable and survives no hidden globals.
 *
 * Conventions (native tab apps on iOS and Android):
 * - Switching tabs keeps every tab's stack (and the screen's draft state).
 * - Re-tapping the active tab pops that tab back to its root.
 * - Back pops the active stack; at a tab root that is not Home, back goes to
 *   Home; at Home's root, back is not handled (the OS may leave the app).
 */

export type PrimaryTab = 'home' | 'activity' | 'send' | 'receive' | 'wallet';

/** Tab order, left to right, as rendered by the tab bar. */
export const PRIMARY_TABS: readonly PrimaryTab[] = ['home', 'activity', 'send', 'receive', 'wallet'];

/** Sentence-case tab labels — also the tabs' accessibility labels. */
export const PRIMARY_TAB_LABELS: Readonly<Record<PrimaryTab, string>> = {
  home: 'Home',
  activity: 'Activity',
  send: 'Send',
  receive: 'Receive',
  wallet: 'Wallet',
};

/** One screen on a tab's stack. `params` carries ids (e.g. a txid), never secrets. */
export interface NavEntry<R extends string> {
  readonly route: R;
  readonly params?: Readonly<Record<string, string>>;
}

export interface NavigationState<R extends string> {
  readonly tab: PrimaryTab;
  /** Every tab's stack; index 0 is the tab's root and is never popped. */
  readonly stacks: Readonly<Record<PrimaryTab, readonly NavEntry<R>[]>>;
}

/** Fresh navigation: each tab holds only its root; `tab` is active. */
export function createNavigation<R extends string>(
  roots: Readonly<Record<PrimaryTab, R>>,
  tab: PrimaryTab = 'home',
): NavigationState<R> {
  return {
    tab,
    stacks: {
      home: [{ route: roots.home }],
      activity: [{ route: roots.activity }],
      send: [{ route: roots.send }],
      receive: [{ route: roots.receive }],
      wallet: [{ route: roots.wallet }],
    },
  };
}

/** The screen on top of the active tab's stack. */
export function currentEntry<R extends string>(nav: NavigationState<R>): NavEntry<R> {
  const stack = nav.stacks[nav.tab];
  const top = stack[stack.length - 1];
  if (top === undefined) throw new Error(`navigation: tab '${nav.tab}' has an empty stack`);
  return top;
}

/** True when the active tab has a screen above its root (a back control is shown). */
export function canGoBack<R extends string>(nav: NavigationState<R>): boolean {
  return nav.stacks[nav.tab].length > 1;
}

/**
 * A tap on a tab-bar item. Switching keeps the target tab's stack; tapping
 * the already-active tab pops it to its root.
 */
export function selectTab<R extends string>(nav: NavigationState<R>, tab: PrimaryTab): NavigationState<R> {
  if (tab !== nav.tab) return { ...nav, tab };
  return popToRoot(nav);
}

/** Switches tabs without touching any stack (in-app links like Home → Send). */
export function switchTab<R extends string>(nav: NavigationState<R>, tab: PrimaryTab): NavigationState<R> {
  return tab === nav.tab ? nav : { ...nav, tab };
}

/** Pushes a screen onto the active tab's stack. */
export function pushRoute<R extends string>(
  nav: NavigationState<R>,
  route: R,
  params?: Readonly<Record<string, string>>,
): NavigationState<R> {
  const entry: NavEntry<R> = params === undefined ? { route } : { route, params };
  return withStack(nav, nav.tab, [...nav.stacks[nav.tab], entry]);
}

/** Pops the active tab's top screen; a root is never popped. */
export function popRoute<R extends string>(nav: NavigationState<R>): NavigationState<R> {
  const stack = nav.stacks[nav.tab];
  if (stack.length <= 1) return nav;
  return withStack(nav, nav.tab, stack.slice(0, -1));
}

export function popToRoot<R extends string>(nav: NavigationState<R>): NavigationState<R> {
  const stack = nav.stacks[nav.tab];
  if (stack.length <= 1) return nav;
  return withStack(nav, nav.tab, stack.slice(0, 1));
}

/**
 * Hardware/system back. `handled: false` means the app is at Home's root and
 * the platform may take the default action (Android leaves the app).
 */
export function handleBack<R extends string>(
  nav: NavigationState<R>,
): { readonly nav: NavigationState<R>; readonly handled: boolean } {
  if (canGoBack(nav)) return { nav: popRoute(nav), handled: true };
  if (nav.tab !== 'home') return { nav: { ...nav, tab: 'home' }, handled: true };
  return { nav, handled: false };
}

/**
 * Generic "go to this screen": a route that is some tab's root switches to
 * that tab (its stack is kept); any other route is pushed onto the active tab.
 */
export function navigateTo<R extends string>(
  nav: NavigationState<R>,
  roots: Readonly<Record<PrimaryTab, R>>,
  route: R,
  params?: Readonly<Record<string, string>>,
): NavigationState<R> {
  const rootTab = tabOfRoot(roots, route);
  if (rootTab !== null) return switchTab(nav, rootTab);
  return pushRoute(nav, route, params);
}

/** The tab whose root is `route`, or null when `route` is not a root. */
export function tabOfRoot<R extends string>(
  roots: Readonly<Record<PrimaryTab, R>>,
  route: R,
): PrimaryTab | null {
  for (const tab of PRIMARY_TABS) {
    if (roots[tab] === route) return tab;
  }
  return null;
}

function withStack<R extends string>(
  nav: NavigationState<R>,
  tab: PrimaryTab,
  stack: readonly NavEntry<R>[],
): NavigationState<R> {
  return { ...nav, stacks: { ...nav.stacks, [tab]: stack } };
}

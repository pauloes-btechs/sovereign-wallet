import { describe, expect, it } from 'vitest';
import {
  PRIMARY_TABS,
  PRIMARY_TAB_LABELS,
  canGoBack,
  createNavigation,
  currentEntry,
  handleBack,
  navigateTo,
  popRoute,
  pushRoute,
  selectTab,
  switchTab,
} from './navigation.js';
import type { PrimaryTab } from './navigation.js';

type Route = 'home' | 'activity' | 'send' | 'receive' | 'wallet' | 'detail' | 'settings';

const ROOTS: Record<PrimaryTab, Route> = {
  home: 'home',
  activity: 'activity',
  send: 'send',
  receive: 'receive',
  wallet: 'wallet',
};

describe('tab navigation', () => {
  it('has five primary tabs with sentence-case labels', () => {
    expect(PRIMARY_TABS).toEqual(['home', 'activity', 'send', 'receive', 'wallet']);
    expect(PRIMARY_TABS.map((t) => PRIMARY_TAB_LABELS[t])).toEqual([
      'Home',
      'Activity',
      'Send',
      'Receive',
      'Wallet',
    ]);
  });

  it('starts every tab at its root', () => {
    const nav = createNavigation(ROOTS);
    expect(nav.tab).toBe('home');
    expect(currentEntry(nav).route).toBe('home');
    expect(canGoBack(nav)).toBe(false);
    for (const tab of PRIMARY_TABS) expect(nav.stacks[tab]).toEqual([{ route: ROOTS[tab] }]);
  });

  it('push/pop works per tab and switching tabs keeps each stack', () => {
    let nav = createNavigation(ROOTS);
    nav = selectTab(nav, 'activity');
    nav = pushRoute(nav, 'detail', { txId: 'abc' });
    expect(currentEntry(nav)).toEqual({ route: 'detail', params: { txId: 'abc' } });
    expect(canGoBack(nav)).toBe(true);

    nav = selectTab(nav, 'wallet');
    nav = pushRoute(nav, 'settings');
    nav = selectTab(nav, 'activity');
    expect(currentEntry(nav).route).toBe('detail'); // kept
    nav = popRoute(nav);
    expect(currentEntry(nav).route).toBe('activity');
    expect(popRoute(nav)).toBe(nav); // the root is never popped
    nav = switchTab(nav, 'wallet');
    expect(currentEntry(nav).route).toBe('settings');
  });

  it('re-tapping the active tab pops it to its root', () => {
    let nav = selectTab(createNavigation(ROOTS), 'wallet');
    nav = pushRoute(pushRoute(nav, 'settings'), 'detail');
    nav = selectTab(nav, 'wallet');
    expect(nav.stacks.wallet).toEqual([{ route: 'wallet' }]);
  });

  it('back pops, then returns to Home, then is unhandled at Home root', () => {
    let nav = pushRoute(selectTab(createNavigation(ROOTS), 'send'), 'detail');
    let result = handleBack(nav);
    expect(result.handled).toBe(true);
    expect(currentEntry(result.nav).route).toBe('send');
    result = handleBack(result.nav);
    expect(result.handled).toBe(true);
    expect(result.nav.tab).toBe('home');
    nav = result.nav;
    result = handleBack(nav);
    expect(result.handled).toBe(false);
    expect(result.nav).toBe(nav);
  });

  it('navigateTo switches to a root route and pushes anything else', () => {
    let nav = createNavigation(ROOTS);
    nav = navigateTo(nav, ROOTS, 'detail');
    expect(nav.tab).toBe('home');
    expect(currentEntry(nav).route).toBe('detail');
    nav = navigateTo(nav, ROOTS, 'receive');
    expect(nav.tab).toBe('receive');
    expect(nav.stacks.home).toHaveLength(2); // Home's stack kept
  });
});

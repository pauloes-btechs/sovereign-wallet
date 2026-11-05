import { useEffect, useState } from 'react';
import { DEMO_REPLAY } from './mode.js';
import type { DemoFixture } from './replay.js';

let cached: Promise<DemoFixture> | null = null;

/** Loads the recorded fixture once (demo build only); null until ready or outside the demo. */
export function useDemoFixture(): DemoFixture | null {
  const [fixture, setFixture] = useState<DemoFixture | null>(null);
  useEffect(() => {
    if (!DEMO_REPLAY) return;
    let cancelled = false;
    cached ??= import('./replay.js').then((m) => m.loadDemoFixture());
    void cached.then((f) => {
      if (!cancelled) setFixture(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return fixture;
}

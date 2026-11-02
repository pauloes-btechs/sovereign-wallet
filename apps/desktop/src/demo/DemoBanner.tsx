import type { DemoFixtureMeta } from './replay.js';

/** Persistent disclosure for the hosted demo: what this is and where the data came from. */
export function DemoBanner({ meta }: { meta: DemoFixtureMeta | null }) {
  const recorded = meta === null ? null : new Date(meta.recordedAt).toISOString().slice(0, 10);
  return (
    <div
      role="note"
      data-testid="demo-banner"
      style={{
        background: '#1a1408',
        borderBottom: '1px solid #3a2a0c',
        color: '#f5b840',
        fontSize: 12,
        lineHeight: 1.5,
        padding: '8px 16px',
        textAlign: 'center',
      }}
    >
      Replayed demo · {meta?.network ?? 'regtest'} · fake funds. Every screen shows real responses recorded from{' '}
      {meta === null ? 'litd' : `litd ${meta.litd} (LND ${meta.lnd})`}
      {recorded === null ? '' : ` on ${recorded}`}. Actions return what the recorded session got; nothing is sent.{' '}
      {/* No remote URLs in app source (packages/privacy egress invariant); the
          everyday-mode demo page carries the source link. */}
      <a href="/" style={{ color: '#f7931a' }}>
        Everyday-mode demo
      </a>
    </div>
  );
}

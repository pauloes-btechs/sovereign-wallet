import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script module, no type declarations
import { compareVersions, diffModels, flattenImports, goVersionToRef, isPrerelease, parseGoMod, protoModel } from './lib.mjs';
// @ts-expect-error — plain ESM script module, no type declarations
import { diffFixtures } from './fixture-diff.mjs';
// @ts-expect-error — plain ESM script module, no type declarations
import { diffQuantum, githubClient, observeQuantum, parseBipHeader, quantumMarkdown, readBaseline, toBaseline } from './quantum.mjs';

describe('version handling', () => {
  it('orders final releases after their release candidates', () => {
    const tags = ['v0.21.5-beta', 'v0.21.5-beta.rc1', 'v0.21.6-beta', 'v0.21.4-beta'];
    expect([...tags].sort(compareVersions)).toEqual(['v0.21.4-beta', 'v0.21.5-beta.rc1', 'v0.21.5-beta', 'v0.21.6-beta']);
    expect(isPrerelease('v0.2.1-rc2')).toBe(true);
    expect(isPrerelease('v0.17.10')).toBe(false);
    expect(compareVersions('v0.17.10', 'v0.17.9')).toBeGreaterThan(0);
  });

  it('resolves Go pseudo-versions to their commit and keeps tags as tags', () => {
    expect(goVersionToRef('v0.2.19-alpha.0.20261021211916-b547baea0f95')).toBe('b547baea0f95');
    expect(goVersionToRef('v1.0.2-0.20260727084653-785ec57e5d1d')).toBe('785ec57e5d1d');
    expect(goVersionToRef('v0.21.6-beta')).toBe('v0.21.6-beta');
  });

  it('reads require blocks and single-line requires from go.mod', () => {
    const mod = parseGoMod(`module x\n\nrequire github.com/a/b v1.2.3\nrequire (\n\tgithub.com/lightningnetwork/lnd v0.21.6-beta\n\tgithub.com/c/d v0.0.0-20260101000000-abcdefabcdef // indirect\n)\n`);
    expect(mod).toEqual({
      'github.com/a/b': 'v1.2.3',
      'github.com/lightningnetwork/lnd': 'v0.21.6-beta',
      'github.com/c/d': 'v0.0.0-20260101000000-abcdefabcdef',
    });
  });
});

const OLD = `syntax = "proto3";
package lnrpc;
service Lightning {
  rpc GetInfo (GetInfoRequest) returns (GetInfoResponse);
  rpc Gone (GetInfoRequest) returns (GetInfoResponse);
  rpc Subscribe (GetInfoRequest) returns (stream GetInfoResponse);
}
message GetInfoRequest {}
message GetInfoResponse {
  string alias = 1;
  uint32 block_height = 2;
  bool synced = 3;
  repeated string uris = 4;
  string old_name = 5;
}
enum State { UNKNOWN = 0; OPEN = 1; CLOSED = 2; }
`;
const NEW = `syntax = "proto3";
package lnrpc;
service Lightning {
  rpc GetInfo (GetInfoRequest) returns (GetInfoResponse);
  rpc Subscribe (GetInfoRequest) returns (GetInfoResponse);
  rpc Added (GetInfoRequest) returns (GetInfoResponse);
}
message GetInfoRequest {}
message GetInfoResponse {
  string alias = 1;
  uint64 block_height = 2;
  repeated string uris = 4;
  string new_name = 5;
  string network = 6;
}
enum State { UNKNOWN = 0; OPEN = 1; PENDING = 3; }
`;

describe('semantic proto diff', () => {
  const changes = diffModels(protoModel(OLD, 'a.proto'), protoModel(NEW, 'a.proto')) as { severity: string; kind: string; name: string }[];
  const kinds = (sev: string) => changes.filter((c) => c.severity === sev).map((c) => `${c.kind} ${c.name}`).sort();

  it('flags removals, retypes, renames and streaming changes as breaking', () => {
    expect(kinds('breaking')).toEqual([
      'enum-value-removed lnrpc.State.CLOSED',
      'field-removed lnrpc.GetInfoResponse.synced',
      'field-renamed lnrpc.GetInfoResponse.old_name',
      'field-type-changed lnrpc.GetInfoResponse.block_height',
      'rpc-removed lnrpc.Lightning.Gone',
      'rpc-streaming-changed lnrpc.Lightning.Subscribe',
    ]);
  });

  it('reports new RPCs, fields and enum values as additive', () => {
    expect(kinds('additive')).toEqual([
      'enum-value-added lnrpc.State.PENDING',
      'field-added lnrpc.GetInfoResponse.network',
      'rpc-added lnrpc.Lightning.Added',
    ]);
  });

  it('finds nothing when only comments change', () => {
    expect(diffModels(protoModel(OLD, 'a'), protoModel(`// note\n${OLD}`, 'a'))).toEqual([]);
  });
});

describe('import flattening', () => {
  it('rewrites upstream import paths to the flat vendored layout and reports unknown ones', () => {
    const { text, missing } = flattenImports('import "swapserverrpc/common.proto";\nimport "lnrpc/new.proto";\nimport "google/protobuf/any.proto";\n', ['common.proto']);
    expect(text).toBe('import "common.proto";\nimport "new.proto";\nimport "google/protobuf/any.proto";\n');
    expect(missing).toEqual(['lnrpc/new.proto']);
  });
});

describe('fixture shape diff', () => {
  const base = { meta: {}, routes: { 'GET /state': { status: 200, body: { phase: 'ready', info: { alias: 'a', height: 1 }, uris: [] } } } };
  it('ignores value changes', () => {
    const head = { meta: {}, routes: { 'GET /state': { status: 200, body: { phase: 'ready', info: { alias: 'b', height: 9 }, uris: [] } } } };
    expect(diffFixtures(base, head)).toEqual([]);
  });
  it('reports missing, retyped and new fields, status changes and dropped routes', () => {
    const head = {
      meta: {},
      routes: { 'GET /state': { status: 200, body: { phase: 'ready', info: { height: '9', network: 'regtest' }, uris: [] } }, 'GET /new': { status: 200, body: {} } },
    };
    expect(diffFixtures(base, head)).toEqual([
      '- `GET /new`: **new route** in the recording (status 200)',
      '- `GET /state`: field `info.alias` **missing** (was string)',
      '- `GET /state`: field `info.height` type number → **string**',
      '- `GET /state`: new field `info.network` (string)',
    ]);
    const flipped = { meta: {}, routes: { 'GET /state': { status: 200, body: { phase: 'locked', info: { alias: 'a', height: 1 }, uris: [] } } } };
    expect(diffFixtures(base, flipped)).toEqual(['- `GET /state`: `phase` `ready` → **`locked`**']);
    const broken = { meta: {}, routes: { 'GET /state': { status: 500, body: { error: 'boom' } } } };
    expect(diffFixtures(base, broken)).toEqual(['- `GET /state`: status 200 → **500** (`boom`)']);
  });
});

// ——— quantum-readiness track (no network: fetch is a stub) ———

const BIP360_HEAD = `<pre>
  BIP: 360
  Layer: Consensus (soft fork)
  Title: Pay-to-Merkle-Root (P2MR)
  Authors: Hunter Beast <hunter@surmount.systems>
  Status: Draft
  Type: Specification
  Assigned: 2024-12-18
  License: BSD-3-Clause
  Version: 0.12.1
  Requires: 340, 341, 342
</pre>

==Introduction==
`;
const BIP361_HEAD = `<pre>
  BIP: 361
  Layer: Consensus (soft fork)
  Title: Post Quantum Migration and Legacy Signature Sunset
  Status: Draft
  Type: Informational
</pre>
`;

interface StubRoute {
  status?: number;
  text?: string;
  json?: unknown;
}

/** A fetch stub keyed by URL (exact, or by prefix with a trailing '*'); unknown URLs → 404. */
function stubFetch(routes: Record<string, StubRoute>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const key = Object.keys(routes).find((k) => (k.endsWith('*') ? url.startsWith(k.slice(0, -1)) : url === k));
    const r: StubRoute = key === undefined ? { status: 404, text: 'Not Found' } : routes[key]!;
    const status = r.status ?? 200;
    return new Response(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''), { status });
  };
  return { impl, calls };
}

const API = 'https://api.github.com';
const search = (q: string) => `${API}/search/issues?q=${encodeURIComponent(q)}&per_page=50`;
const commitFor = (file: string) => `${API}/repos/bitcoin/bips/commits?path=${encodeURIComponent(file)}&per_page=1`;
const pr = (number: number, title: string, state: string, merged = false) => ({
  number,
  title,
  state,
  html_url: `https://github.com/x/pull/${number}`,
  pull_request: { merged_at: merged ? '2027-01-01T00:00:00Z' : null },
});

function baseRoutes(): Record<string, StubRoute> {
  return {
    [`${API}/repos/bitcoin/bips/contents/bip-0360.mediawiki`]: { text: BIP360_HEAD },
    [`${API}/repos/bitcoin/bips/contents/bip-0361.mediawiki`]: { text: BIP361_HEAD },
    [commitFor('bip-0360.mediawiki')]: { json: [{ sha: 'abc', commit: { committer: { date: '2026-10-30T00:00:00Z' } } }] },
    [commitFor('bip-0361.mediawiki')]: { json: [] },
    [search('repo:bitcoin/bitcoin is:pr "BIP-360"')]: { json: { items: [] } },
    [search('repo:bitcoin/bitcoin is:pr "BIP360"')]: { json: { items: [] } },
    [search('repo:bitcoin/bitcoin is:pr P2MR')]: { json: { items: [] } },
    [search('repo:bitcoin/bips is:pr SHRINCS')]: { json: { items: [] } },
  };
}

const BASELINE = {
  recordedAt: '2026-11-08',
  bips: {
    '360': { file: 'bip-0360.mediawiki', present: true, status: 'Draft', version: '0.12.1', lastCommitSha: 'abc', lastCommitDate: '2026-10-30T00:00:00Z' },
    '361': { file: 'bip-0361.mediawiki', present: true, status: 'Draft', version: null, lastCommitSha: null, lastCommitDate: null },
  },
  corePrs: [],
  shrincs: { prs: [], bips: [] },
};

describe('quantum readiness: BIP headers', () => {
  it('reads Status and Version from the mediawiki header', () => {
    expect(parseBipHeader(BIP360_HEAD)).toEqual({ bip: 360, title: 'Pay-to-Merkle-Root (P2MR)', layer: 'Consensus (soft fork)', status: 'Draft', version: '0.12.1' });
    expect(parseBipHeader(BIP361_HEAD)).toMatchObject({ bip: 361, status: 'Draft', version: null });
  });

  it('the committed baseline records BIP-360 as Draft 0.12.1', () => {
    const committed = readBaseline();
    expect(committed.bips['360']).toMatchObject({ file: 'bip-0360.mediawiki', present: true, status: 'Draft', version: '0.12.1' });
    // Content is tracked by commit: both watched files carry a full commit SHA.
    expect(committed.bips['360'].lastCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.bips['361'].lastCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('quantum readiness: observing and diffing', () => {
  it('observes the unchanged state with no changes, sending the token when given', async () => {
    const { impl, calls } = stubFetch(baseRoutes());
    const obs = await observeQuantum(githubClient(impl, 'tok'), new Date('2026-11-09T00:00:00Z'));
    expect(obs.errors).toEqual([]);
    expect(obs.bips['360']).toMatchObject({ present: true, status: 'Draft', version: '0.12.1', lastCommit: { sha: 'abc' } });
    expect(diffQuantum(BASELINE, obs)).toEqual([]);
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true);
    expect(calls.every((c) => c.url.startsWith(API))).toBe(true);
  });

  it('flags BIP-360 leaving Draft and a version bump', async () => {
    const routes = baseRoutes();
    routes[`${API}/repos/bitcoin/bips/contents/bip-0360.mediawiki`] = { text: BIP360_HEAD.replace('Status: Draft', 'Status: Complete').replace('0.12.1', '1.0.0') };
    const obs = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    const changes = diffQuantum(BASELINE, obs) as { kind: string; detail: string }[];
    expect(changes.map((c) => c.kind)).toEqual(['bip-status', 'bip-version']);
    expect(changes[0]!.detail).toContain('Status Draft → **Complete**');
    const md = quantumMarkdown(BASELINE, obs, changes);
    expect(md).toContain('### Quantum readiness');
    expect(md).toContain('**2 change(s)**');
  });

  it('flags a new Bitcoin Core P2MR PR (deduplicated across queries) and its merge', async () => {
    const routes = baseRoutes();
    routes[search('repo:bitcoin/bitcoin is:pr P2MR')] = { json: { items: [pr(40000, 'consensus: BIP-360 P2MR', 'open')] } };
    routes[search('repo:bitcoin/bitcoin is:pr "BIP-360"')] = { json: { items: [pr(40000, 'consensus: BIP-360 P2MR', 'open')] } };
    const opened = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect(opened.corePrs).toHaveLength(1);
    expect((diffQuantum(BASELINE, opened) as { kind: string }[]).map((c) => c.kind)).toEqual(['pr-new']);

    routes[search('repo:bitcoin/bitcoin is:pr P2MR')] = { json: { items: [pr(40000, 'consensus: BIP-360 P2MR', 'closed', true)] } };
    routes[search('repo:bitcoin/bitcoin is:pr "BIP-360"')] = { json: { items: [] } };
    const merged = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    const changes = diffQuantum({ ...BASELINE, corePrs: opened.corePrs }, merged) as { kind: string; detail: string }[];
    expect(changes.map((c) => c.kind)).toEqual(['pr-state']);
    expect(changes[0]!.detail).toContain('open → **merged**');
  });

  it('tracks the SHRINCS draft: PR appears, gets a BIP number, then merges', async () => {
    const routes = baseRoutes();
    routes[search('repo:bitcoin/bips is:pr SHRINCS')] = { json: { items: [pr(2100, 'BIP draft: SHRINCS signatures', 'open')] } };
    routes[`${API}/repos/bitcoin/bips/pulls/2100/files?per_page=100`] = {
      json: [{ filename: 'bip-shrincs.mediawiki', status: 'added', contents_url: `${API}/repos/bitcoin/bips/contents/bip-shrincs.mediawiki?ref=deadbeef` }],
    };
    const first = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect(first.shrincs).toEqual({ prs: [{ number: 2100, title: 'BIP draft: SHRINCS signatures', state: 'open', url: 'https://github.com/x/pull/2100' }], bips: [] });
    expect((diffQuantum(BASELINE, first) as { kind: string }[]).map((c) => c.kind)).toEqual(['pr-new']);

    routes[`${API}/repos/bitcoin/bips/pulls/2100/files?per_page=100`] = {
      json: [{ filename: 'bip-0399.mediawiki', status: 'added', contents_url: `${API}/repos/bitcoin/bips/contents/bip-0399.mediawiki?ref=deadbeef` }],
    };
    routes[`${API}/repos/bitcoin/bips/contents/bip-0399.mediawiki?ref=deadbeef`] = { text: '<pre>\n  BIP: 399\n  Title: SHRINCS\n  Status: Draft\n</pre>\n' };
    const numbered = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    const b1 = { ...BASELINE, shrincs: first.shrincs };
    const c1 = diffQuantum(b1, numbered) as { kind: string; detail: string }[];
    expect(c1.map((c) => c.kind)).toEqual(['bip-number']);
    expect(c1[0]!.detail).toContain('`bip-0399.mediawiki` (BIP 399, PR #2100, Status Draft)');

    routes[search('repo:bitcoin/bips is:pr SHRINCS')] = { json: { items: [pr(2100, 'BIP draft: SHRINCS signatures', 'closed', true)] } };
    routes[`${API}/repos/bitcoin/bips/contents/bip-0399.mediawiki`] = { text: '<pre>\n  BIP: 399\n  Status: Draft\n</pre>\n' };
    const merged = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect((diffQuantum({ ...BASELINE, shrincs: numbered.shrincs }, merged) as { kind: string }[]).map((c) => c.kind)).toEqual(['pr-state']);
  });

  it('asks for a baseline when a section was never recorded, and never treats failures as changes', async () => {
    const routes = baseRoutes();
    routes[search('repo:bitcoin/bips is:pr SHRINCS')] = { status: 403, text: 'rate limited' };
    const obs = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect(obs.shrincs).toBeNull();
    expect(obs.errors).toHaveLength(1);
    const changes = diffQuantum({ ...BASELINE, corePrs: null, shrincs: null }, obs) as { track: string; kind: string }[];
    expect(changes).toEqual([{ track: 'core', kind: 'first-observation', detail: 'Bitcoin Core BIP-360 / P2MR PRs: none found' }]);
    expect(quantumMarkdown(BASELINE, obs, changes)).toContain('Not observed this run');
    // Recording keeps the previous value for what failed.
    expect(toBaseline(obs, BASELINE).shrincs).toEqual(BASELINE.shrincs);
  });

  it('notices a watched BIP file disappearing', async () => {
    const routes = baseRoutes();
    delete routes[`${API}/repos/bitcoin/bips/contents/bip-0361.mediawiki`];
    const obs = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect((diffQuantum(BASELINE, obs) as { kind: string }[]).map((c) => c.kind)).toEqual(['bip-removed']);
  });
});

describe('quantum readiness: BIP content changes (last commit)', () => {
  const commitRoute = (sha: string, date = '2026-11-20T00:00:00Z') => ({ json: [{ sha, commit: { committer: { date } } }] });

  it('flags a content change when the last commit moves but Status and Version do not', async () => {
    const routes = baseRoutes();
    routes[commitFor('bip-0360.mediawiki')] = commitRoute('def0123456789abcdef');
    const obs = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    const changes = diffQuantum(BASELINE, obs) as { track: string; kind: string; detail: string }[];
    expect(changes.map((c) => [c.track, c.kind])).toEqual([['bips', 'bip-content']]);
    expect(changes[0]!.detail).toContain('content changed');
    expect(changes[0]!.detail).toContain('Status and Version unchanged');
    expect(changes[0]!.detail).toContain('def012345678');
    expect(quantumMarkdown(BASELINE, obs, changes)).toContain('`def012345678`');
  });

  it('reports a Status change once, not again as a content change', async () => {
    const routes = baseRoutes();
    routes[`${API}/repos/bitcoin/bips/contents/bip-0360.mediawiki`] = { text: BIP360_HEAD.replace('Status: Draft', 'Status: Complete') };
    routes[commitFor('bip-0360.mediawiki')] = commitRoute('fff');
    const obs = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect((diffQuantum(BASELINE, obs) as { kind: string }[]).map((c) => c.kind)).toEqual(['bip-status']);
  });

  it('a failed commit lookup is an error, never a change, and recording keeps the previous SHA', async () => {
    const routes = baseRoutes();
    routes[commitFor('bip-0360.mediawiki')] = { status: 502, text: 'bad gateway' };
    const obs = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect(obs.errors.some((e: string) => e.includes('last commit of bip-0360.mediawiki'))).toBe(true);
    expect(diffQuantum(BASELINE, obs)).toEqual([]);
    expect(toBaseline(obs, BASELINE).bips['360']).toMatchObject({ lastCommitSha: 'abc', lastCommitDate: '2026-10-30T00:00:00Z' });
  });

  it('records the observed commit in the baseline, and a later run with the same commit is quiet', async () => {
    const routes = baseRoutes();
    routes[commitFor('bip-0360.mediawiki')] = commitRoute('0123abcd');
    const first = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    const recorded = toBaseline(first, BASELINE);
    expect(recorded.bips['360']).toMatchObject({ status: 'Draft', version: '0.12.1', lastCommitSha: '0123abcd', lastCommitDate: '2026-11-20T00:00:00Z' });
    const again = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect(diffQuantum(recorded, again)).toEqual([]);
  });

  it('a baseline from before commits were tracked records the commit as a first observation', async () => {
    const legacy = {
      ...BASELINE,
      bips: {
        '360': { file: 'bip-0360.mediawiki', present: true, status: 'Draft', version: '0.12.1' },
        '361': { file: 'bip-0361.mediawiki', present: true, status: 'Draft', version: null },
      },
    };
    const obs = await observeQuantum(githubClient(stubFetch(baseRoutes()).impl, undefined));
    const changes = diffQuantum(legacy, obs) as { kind: string; detail: string }[];
    expect(changes.map((c) => c.kind)).toEqual(['first-observation']);
    expect(changes[0]!.detail).toContain('last commit');
  });

  it('a removed file drops its commit from the baseline', async () => {
    const routes = baseRoutes();
    delete routes[`${API}/repos/bitcoin/bips/contents/bip-0360.mediawiki`];
    const obs = await observeQuantum(githubClient(stubFetch(routes).impl, undefined));
    expect(toBaseline(obs, BASELINE).bips['360']).toMatchObject({ present: false, lastCommitSha: null });
  });
});

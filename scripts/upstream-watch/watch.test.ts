import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script module, no type declarations
import { compareVersions, diffModels, flattenImports, goVersionToRef, isPrerelease, parseGoMod, protoModel } from './lib.mjs';
// @ts-expect-error — plain ESM script module, no type declarations
import { diffFixtures } from './fixture-diff.mjs';

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

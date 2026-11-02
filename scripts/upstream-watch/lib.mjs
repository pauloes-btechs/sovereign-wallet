/**
 * Shared helpers for the Lightning Labs upstream watch.
 *
 * Network access is limited to public GitHub: `git ls-remote` for release
 * tags and raw.githubusercontent.com for go.mod / .proto files at a ref.
 * No token is needed; nothing is downloaded or executed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const protosDir = path.join(repoRoot, 'packages/litd-proto/protos');

// ——— versions ———

/** Parses vX.Y.Z[-beta|-alpha][.rcN|-rcN]; null for anything else. */
export function parseVersion(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-(beta|alpha))?(?:[.-]?rc(\d+))?$/.exec(tag);
  if (m === null) return null;
  return {
    tag,
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    channel: m[4] ?? '',
    rc: m[5] === undefined ? null : Number(m[5]),
  };
}

/** Semver-ish compare: numbers, then final release > release candidate. */
export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  for (let i = 0; i < 3; i++) if (va.nums[i] !== vb.nums[i]) return va.nums[i] - vb.nums[i];
  if (va.rc === vb.rc) return 0;
  if (va.rc === null) return 1;
  if (vb.rc === null) return -1;
  return va.rc - vb.rc;
}

export function isPrerelease(tag) {
  return parseVersion(tag)?.rc !== null;
}

export function listTags(repo) {
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', `https://github.com/${repo}`], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return out
    .split('\n')
    .map((l) => l.split('refs/tags/')[1])
    .filter((t) => t !== undefined && parseVersion(t) !== null);
}

/** Newest final release (no release candidates). */
export function latestRelease(repo) {
  const tags = listTags(repo).filter((t) => !isPrerelease(t));
  tags.sort(compareVersions);
  return tags.at(-1) ?? null;
}

/** Releases strictly newer than `pinned` (finals only), oldest first. */
export function releasesSince(repo, pinned) {
  return listTags(repo)
    .filter((t) => !isPrerelease(t) && compareVersions(t, pinned) > 0)
    .sort(compareVersions);
}

// ——— fetching ———

export async function fetchRaw(repo, ref, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

/** Go module version → git ref: pseudo-versions resolve to their commit, tags stay tags. */
export function goVersionToRef(version) {
  // vX.Y.Z-0.yyyymmddhhmmss-abcdef123456 and vX.Y.Z-pre.0.yyyymmddhhmmss-abcdef123456
  const pseudo = /[.-]\d{14}-([0-9a-f]{12})$/.exec(version);
  return pseudo === null ? version.replace(/\+incompatible$/, '') : pseudo[1];
}

/** `require` entries of a go.mod: module → version (indirect deps included). */
export function parseGoMod(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+(v[^\s]+)/i.exec(line);
    if (m !== null) out[m[1]] = m[2];
  }
  return out;
}

export function readJson(rel) {
  return JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8'));
}

/** What a litd release bundles: module → { version, ref } for every module in upstream.json. */
export async function litdBundle(litdTag) {
  const map = readJson('packages/litd-proto/protos/upstream.json');
  const goMod = parseGoMod(await fetchRaw(map.litd.repo, litdTag, 'go.mod'));
  const bundle = {};
  for (const mod of Object.keys(map.modules)) {
    if (mod === map.litd.module) {
      bundle[mod] = { version: litdTag, ref: litdTag };
      continue;
    }
    const version = goMod[mod];
    if (version === undefined) throw new Error(`litd ${litdTag} go.mod no longer requires ${mod}`);
    bundle[mod] = { version, ref: goVersionToRef(version) };
  }
  return bundle;
}

// ——— pins in this repo ———

export function currentPins() {
  const lock = readJson('sidecars.lock.json');
  const compose = readFileSync(path.join(repoRoot, 'harness/regtest/docker-compose.yml'), 'utf8');
  const images = {};
  for (const m of compose.matchAll(/image:\s*(?:\$\{[A-Z_]+:-)?([^\s}]+)\}?/g)) {
    const [name, tag] = m[1].split(':');
    images[name] = tag;
  }
  const waved = /const PINNED_WAVES_VERSION = '([^']+)'/.exec(
    readFileSync(path.join(repoRoot, 'scripts/fetch-waved.mjs'), 'utf8'),
  )?.[1];
  return {
    litd: lock.litd.tag,
    lndImage: images['lightninglabs/lnd'],
    litdImage: images['lightninglabs/lightning-terminal'],
    apertureImage: images['lightninglabs/aperture'],
    waved: waved === undefined ? undefined : `v${waved}`,
  };
}

// ——— proto semantics ———

function typeName(t) {
  return String(t).replace(/^\./, '');
}

/** Flattens a .proto into comparable definitions, keyed by fully-qualified name. */
export function protoModel(source, filename) {
  const parsed = protobuf.parse(source, { keepCase: true, alternateCommentMode: true });
  const model = { package: parsed.package ?? '', imports: parsed.imports ?? [], messages: {}, enums: {}, services: {} };
  const walk = (ns, prefix) => {
    for (const child of ns.nestedArray ?? []) {
      const fq = prefix === '' ? child.name : `${prefix}.${child.name}`;
      if (child instanceof protobuf.Type) {
        const fields = {};
        for (const f of child.fieldsArray) {
          fields[f.name] = {
            id: f.id,
            type: typeName(f.type),
            rule: f.map ? `map<${f.keyType}>` : f.repeated ? 'repeated' : f.options?.proto3_optional ? 'optional' : '',
            oneof: f.partOf?.name ?? null,
          };
        }
        model.messages[fq] = { fields, reserved: (child.reserved ?? []).map(String) };
        walk(child, fq);
      } else if (child instanceof protobuf.Enum) {
        model.enums[fq] = { values: { ...child.values } };
      } else if (child instanceof protobuf.Service) {
        const methods = {};
        for (const m of child.methodsArray) {
          methods[m.name] = {
            request: typeName(m.requestType),
            response: typeName(m.responseType),
            requestStream: Boolean(m.requestStream),
            responseStream: Boolean(m.responseStream),
          };
        }
        model.services[fq] = { methods };
      } else if (child instanceof protobuf.Namespace) {
        walk(child, fq);
      }
    }
  };
  walk(parsed.root, '');
  model.file = filename;
  return model;
}

/**
 * Semantic diff old → new. Each change: { severity: 'breaking'|'additive'|'deprecation', kind, name, detail, field? }.
 * Breaking = something our generated client or wire format relies on went
 * away or changed meaning. Renames that keep the field number are breaking
 * for the TypeScript client (property name) but wire-compatible; flagged so.
 */
export function diffModels(a, b) {
  const changes = [];
  const add = (severity, kind, name, detail, extra = {}) => changes.push({ severity, kind, name, detail, ...extra });

  for (const [svc, def] of Object.entries(a.services)) {
    const next = b.services[svc];
    if (next === undefined) {
      add('breaking', 'service-removed', svc, `service ${svc} removed`);
      continue;
    }
    for (const [m, md] of Object.entries(def.methods)) {
      const nm = next.methods[m];
      if (nm === undefined) add('breaking', 'rpc-removed', `${svc}.${m}`, 'RPC removed');
      else {
        if (nm.request !== md.request) add('breaking', 'rpc-request-changed', `${svc}.${m}`, `request ${md.request} → ${nm.request}`);
        if (nm.response !== md.response) add('breaking', 'rpc-response-changed', `${svc}.${m}`, `response ${md.response} → ${nm.response}`);
        if (nm.requestStream !== md.requestStream || nm.responseStream !== md.responseStream) {
          add('breaking', 'rpc-streaming-changed', `${svc}.${m}`, 'streaming mode changed');
        }
      }
    }
    for (const m of Object.keys(next.methods)) {
      if (def.methods[m] === undefined) add('additive', 'rpc-added', `${svc}.${m}`, 'new RPC');
    }
  }
  for (const svc of Object.keys(b.services)) if (a.services[svc] === undefined) add('additive', 'service-added', svc, 'new service');

  for (const [msg, def] of Object.entries(a.messages)) {
    const next = b.messages[msg];
    if (next === undefined) {
      add('breaking', 'message-removed', msg, 'message removed');
      continue;
    }
    const byId = Object.fromEntries(Object.entries(next.fields).map(([n, f]) => [f.id, n]));
    for (const [f, fd] of Object.entries(def.fields)) {
      const nf = next.fields[f];
      if (nf === undefined) {
        const renamedTo = byId[fd.id];
        if (renamedTo !== undefined) {
          add('breaking', 'field-renamed', `${msg}.${f}`, `renamed to ${renamedTo} (same field number ${fd.id}: wire-compatible, TS property changes)`, { field: f });
        } else {
          add('breaking', 'field-removed', `${msg}.${f}`, `field #${fd.id} removed`, { field: f });
        }
        continue;
      }
      if (nf.id !== fd.id) add('breaking', 'field-number-changed', `${msg}.${f}`, `#${fd.id} → #${nf.id}`, { field: f });
      if (nf.type !== fd.type) add('breaking', 'field-type-changed', `${msg}.${f}`, `${fd.type} → ${nf.type}`, { field: f });
      if (nf.rule !== fd.rule) add('breaking', 'field-label-changed', `${msg}.${f}`, `${fd.rule || 'singular'} → ${nf.rule || 'singular'}`, { field: f });
    }
    for (const [f, nf] of Object.entries(next.fields)) {
      if (def.fields[f] === undefined && !Object.values(def.fields).some((x) => x.id === nf.id)) {
        add('additive', 'field-added', `${msg}.${f}`, `new field #${nf.id} (${nf.rule ? `${nf.rule} ` : ''}${nf.type})`, { field: f });
      }
    }
  }
  for (const msg of Object.keys(b.messages)) if (a.messages[msg] === undefined) add('additive', 'message-added', msg, 'new message');

  for (const [en, def] of Object.entries(a.enums)) {
    const next = b.enums[en];
    if (next === undefined) {
      add('breaking', 'enum-removed', en, 'enum removed');
      continue;
    }
    for (const [v, num] of Object.entries(def.values)) {
      if (next.values[v] === undefined) add('breaking', 'enum-value-removed', `${en}.${v}`, `value ${num} removed`);
      else if (next.values[v] !== num) add('breaking', 'enum-value-renumbered', `${en}.${v}`, `${num} → ${next.values[v]}`);
    }
    for (const [v, num] of Object.entries(next.values)) {
      if (def.values[v] === undefined) add('additive', 'enum-value-added', `${en}.${v}`, `new value ${num}`);
    }
  }
  for (const en of Object.keys(b.enums)) if (a.enums[en] === undefined) add('additive', 'enum-added', en, 'new enum');
  return changes;
}

/** Upstream file → vendored layout: imports flattened to basenames we vendor. */
export function flattenImports(source, vendoredNames) {
  const missing = [];
  const text = source.replace(/^import\s+(public\s+|weak\s+)?"([^"]+)";/gm, (line, mod, imp) => {
    if (imp.startsWith('google/protobuf/')) return line;
    const base = path.posix.basename(imp);
    if (!vendoredNames.includes(base)) missing.push(imp);
    return `import ${mod ?? ''}"${base}";`;
  });
  return { text, missing };
}

export function camelCase(snake) {
  return snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

let protoConsumers = null;

/** Our own (non-generated, non-test) source files that import the generated Lightning Labs clients. */
function litdProtoConsumers() {
  if (protoConsumers !== null) return protoConsumers;
  try {
    protoConsumers = execFileSync(
      'git',
      ['grep', '-l', '-E', "from '@sovereign/litd-proto'|from \"@sovereign/litd-proto\"", '--', 'apps', 'packages', 'services', 'harness', ':!**/generated/**', ':!**/*.test.ts', ':!**/*.spec.ts'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    protoConsumers = [];
  }
  return protoConsumers;
}

/**
 * Where our code reads or writes a proto field (camelCase in the generated
 * TS client), for actionable reports. Only searches files that import
 * @sovereign/litd-proto, and only property access / object-literal keys.
 */
export function findUsages(fieldSnake, maxHits = 5) {
  const ident = camelCase(fieldSnake);
  const files = litdProtoConsumers();
  if (files.length === 0) return [];
  try {
    const out = execFileSync('git', ['grep', '-n', '-E', `\\.${ident}\\b|\\b${ident}\\??:`, '--', ...files], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean).slice(0, maxHits).map((l) => l.split(':').slice(0, 2).join(':'));
  } catch {
    return [];
  }
}

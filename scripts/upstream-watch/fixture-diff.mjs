#!/usr/bin/env node
/**
 * Shape diff between two demo fixtures (apps/desktop/src/demo/fixtures/modeb.json
 * format): what the desktop UI receives from the bridge, before vs after an
 * upstream bump. Values are ignored (regtest pubkeys, amounts and txids differ
 * every run); field paths, JSON types, routes and HTTP statuses are compared.
 *
 *   node scripts/upstream-watch/fixture-diff.mjs --base=<old.json> --head=<new.json> [--out=diff.md]
 *
 * Exit 0 always; the markdown says whether anything changed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** path → JSON type, with array elements merged under `[]`. */
export function shapeOf(value, prefix = '', out = new Map()) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (prefix !== '') {
    const prev = out.get(prefix);
    out.set(prefix, prev === undefined || prev === type ? type : [...new Set([...prev.split('|'), type])].sort().join('|'));
  }
  if (type === 'array') for (const el of value) shapeOf(el, `${prefix}[]`, out);
  else if (type === 'object') for (const [k, v] of Object.entries(value)) shapeOf(v, prefix === '' ? k : `${prefix}.${k}`, out);
  return out;
}

/** Fields whose VALUE carries meaning across runs (states, errors), unlike amounts and ids. */
const STATUS_KEYS = new Set(['error', 'phase', 'available', 'status', 'state']);

/** path → scalar value for status-like keys (first occurrence; arrays by index 0). */
function statusValues(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    if (value.length > 0) statusValues(value[0], `${prefix}[]`, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix === '' ? k : `${prefix}.${k}`;
      if (STATUS_KEYS.has(k) && (v === null || typeof v !== 'object')) out.set(p, v);
      else statusValues(v, p, out);
    }
  }
  return out;
}

export function diffFixtures(base, head) {
  const lines = [];
  const keys = [...new Set([...Object.keys(base.routes), ...Object.keys(head.routes)])].sort();
  for (const key of keys) {
    const a = base.routes[key];
    const b = head.routes[key];
    if (a === undefined) {
      lines.push(`- \`${key}\`: **new route** in the recording (status ${b.status})`);
      continue;
    }
    if (b === undefined) {
      lines.push(`- \`${key}\`: **no longer answered** in the recording (was ${a.status}) — the UI flow that calls it broke or changed`);
      continue;
    }
    if (a.status !== b.status) {
      // The body is a different document now (usually an error); field-level noise adds nothing.
      lines.push(`- \`${key}\`: status ${a.status} → **${b.status}**${b.body?.error ? ` (\`${String(b.body.error).slice(0, 160)}\`)` : ''}`);
      continue;
    }
    const sa = shapeOf(a.body);
    const sb = shapeOf(b.body);
    const removed = [...sa.keys()].filter((p) => !sb.has(p) && !p.endsWith('[]'));
    const added = [...sb.keys()].filter((p) => !sa.has(p) && !p.endsWith('[]'));
    const retyped = [...sa.keys()].filter((p) => sb.has(p) && sa.get(p) !== sb.get(p));
    // A field only present inside a (possibly empty) array isn't a removal if the array is empty this run.
    const emptyArrays = (shape, p) => [...shape.keys()].some((q) => p.startsWith(`${q}[]`) && !shape.has(`${q}[]`));
    for (const p of removed) if (!emptyArrays(sb, p)) lines.push(`- \`${key}\`: field \`${p}\` **missing** (was ${sa.get(p)})`);
    for (const p of retyped) lines.push(`- \`${key}\`: field \`${p}\` type ${sa.get(p)} → **${sb.get(p)}**`);
    for (const p of added) if (!emptyArrays(sa, p)) lines.push(`- \`${key}\`: new field \`${p}\` (${sb.get(p)})`);
    const va = statusValues(a.body);
    const vb = statusValues(b.body);
    for (const [p, v] of va) {
      if (vb.has(p) && vb.get(p) !== v) {
        const show = (x) => `\`${String(x).slice(0, 140)}\``;
        lines.push(`- \`${key}\`: \`${p}\` ${show(v)} → **${show(vb.get(p))}**`);
      }
    }
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = JSON.parse(readFileSync(arg('base'), 'utf8'));
  const head = JSON.parse(readFileSync(arg('head'), 'utf8'));
  const lines = diffFixtures(base, head);
  const md = [
    `### Desktop UI responses: ${base.meta.litd} (LND ${base.meta.lnd}) → ${head.meta.litd} (LND ${head.meta.lnd})`,
    '',
    lines.length === 0
      ? 'Every bridge response the desktop UI reads kept its shape and status.'
      : `${lines.length} difference(s) in what the desktop UI receives:`,
    '',
    ...lines,
  ].join('\n');
  if (arg('out') !== undefined) writeFileSync(arg('out'), `${md}\n`);
  console.log(md);
}

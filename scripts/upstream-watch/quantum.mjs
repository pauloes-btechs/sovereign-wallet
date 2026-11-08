/**
 * Quantum-readiness track of the weekly upstream watch.
 *
 * Watches the public specs and code that decide when this wallet may turn
 * on post-quantum output types (see docs/QUANTUM_READINESS.md):
 *
 * - bitcoin/bips bip-0360.mediawiki (P2MR) and bip-0361.mediawiki (PQ
 *   migration / legacy signature sunset): the Status and Version header
 *   lines, via the GitHub contents API, plus the last commit touching each.
 * - Bitcoin Core pull requests implementing BIP-360 / P2MR (search API).
 * - The SHRINCS post-quantum signature draft BIP: bitcoin/bips pull requests
 *   mentioning SHRINCS, the BIP number once a bip-NNNN file appears in one,
 *   and that file's Status line.
 *
 * Observations are compared with the committed baseline
 * (quantum-baseline.json, same role as the pins for releases); any change
 * puts a "Quantum readiness" section in the weekly issue. Network access goes
 * through the injected `fetchImpl` so tests never touch the network.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'quantum-baseline.json');

export const WATCHED_BIPS = [
  { bip: 360, file: 'bip-0360.mediawiki', name: 'BIP-360 Pay-to-Merkle-Root (P2MR)' },
  { bip: 361, file: 'bip-0361.mediawiki', name: 'BIP-361 Post Quantum Migration and Legacy Signature Sunset' },
];

export const CORE_PR_QUERIES = ['repo:bitcoin/bitcoin is:pr "BIP-360"', 'repo:bitcoin/bitcoin is:pr "BIP360"', 'repo:bitcoin/bitcoin is:pr P2MR'];
export const SHRINCS_PR_QUERY = 'repo:bitcoin/bips is:pr SHRINCS';

const API = 'https://api.github.com';

/** Header fields of a BIP (mediawiki `<pre>` block or markdown preamble). */
export function parseBipHeader(text) {
  const head = text.split('\n').slice(0, 40).join('\n');
  const field = (name) => new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm').exec(head)?.[1] ?? null;
  const bip = field('BIP');
  return {
    bip: bip !== null && /^\d+$/.test(bip) ? Number(bip) : null,
    title: field('Title'),
    layer: field('Layer'),
    status: field('Status'),
    version: field('Version'),
  };
}

/** GitHub REST client over an injected fetch. Token optional (raises rate limits). */
export function githubClient(fetchImpl = fetch, token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN) {
  const headers = (accept) => ({
    accept,
    'user-agent': 'sovereign-wallet-upstream-watch',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const get = async (url, accept) => {
    const res = await fetchImpl(url, { headers: headers(accept) });
    return res;
  };
  return {
    /** Raw file text, or null when the file does not exist (404). */
    async fileText(repo, filePath, ref) {
      const url = `${API}/repos/${repo}/contents/${filePath}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
      const res = await get(url, 'application/vnd.github.raw+json');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      return res.text();
    },
    async lastCommit(repo, filePath) {
      const url = `${API}/repos/${repo}/commits?path=${encodeURIComponent(filePath)}&per_page=1`;
      const res = await get(url, 'application/vnd.github+json');
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const [c] = await res.json();
      return c === undefined ? null : { sha: c.sha, date: c.commit?.committer?.date ?? null };
    },
    async searchPrs(query) {
      const url = `${API}/search/issues?q=${encodeURIComponent(query)}&per_page=50`;
      const res = await get(url, 'application/vnd.github+json');
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const body = await res.json();
      return (body.items ?? []).map((i) => ({
        number: i.number,
        title: i.title,
        state: i.pull_request?.merged_at ? 'merged' : i.state,
        url: i.html_url,
      }));
    },
    async prFiles(repo, number) {
      const url = `${API}/repos/${repo}/pulls/${number}/files?per_page=100`;
      const res = await get(url, 'application/vnd.github+json');
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      return (await res.json()).map((f) => ({ filename: f.filename, status: f.status, ref: new URL(f.contents_url).searchParams.get('ref') }));
    },
  };
}

const byNumber = (a, b) => a.number - b.number;

/** One observation of everything the quantum track watches. Never throws: failures land in `errors`. */
export async function observeQuantum(client, now = new Date()) {
  const errors = [];
  const bips = {};
  for (const w of WATCHED_BIPS) {
    try {
      const text = await client.fileText('bitcoin/bips', w.file);
      if (text === null) {
        bips[w.bip] = { file: w.file, present: false, status: null, version: null };
        continue;
      }
      const h = parseBipHeader(text);
      let lastCommit = null;
      try {
        lastCommit = await client.lastCommit('bitcoin/bips', w.file);
      } catch (err) {
        errors.push(`last commit of ${w.file}: ${err.message}`);
      }
      bips[w.bip] = { file: w.file, present: true, status: h.status, version: h.version, lastCommit };
    } catch (err) {
      errors.push(`${w.file}: ${err.message}`);
      bips[w.bip] = null;
    }
  }

  let corePrs = null;
  try {
    const seen = new Map();
    for (const q of CORE_PR_QUERIES) for (const pr of await client.searchPrs(q)) seen.set(pr.number, pr);
    corePrs = [...seen.values()].sort(byNumber);
  } catch (err) {
    errors.push(`Bitcoin Core PR search: ${err.message}`);
  }

  let shrincs = null;
  try {
    const prs = (await client.searchPrs(SHRINCS_PR_QUERY)).sort(byNumber);
    const files = [];
    for (const pr of prs.slice(0, 10)) {
      for (const f of await client.prFiles('bitcoin/bips', pr.number)) {
        const m = /^bip-(\d{4})\.(mediawiki|md)$/.exec(f.filename);
        if (m === null || f.status === 'removed') continue;
        const text = await client.fileText('bitcoin/bips', f.filename, pr.state === 'merged' ? undefined : (f.ref ?? undefined));
        const h = text === null ? null : parseBipHeader(text);
        files.push({ pr: pr.number, file: f.filename, bip: Number(m[1]), status: h?.status ?? null });
      }
    }
    shrincs = { prs, bips: files };
  } catch (err) {
    errors.push(`SHRINCS PR search: ${err.message}`);
  }

  return { observedAt: now.toISOString(), bips, corePrs, shrincs, errors };
}

/**
 * Baseline → observation changes. Each: { track, kind, detail }. A section
 * the baseline has never recorded (null) yields one `first-observation`
 * change so the issue asks for the baseline to be filled in. Failed
 * observations (null) are not changes; they are reported as errors.
 */
export function diffQuantum(base, obs) {
  const changes = [];
  const add = (track, kind, detail) => changes.push({ track, kind, detail });

  for (const w of WATCHED_BIPS) {
    const a = base.bips?.[w.bip] ?? null;
    const b = obs.bips?.[w.bip] ?? null;
    if (b === null) continue;
    if (a === null) {
      add('bips', 'first-observation', `${w.name}: ${b.present ? `Status ${b.status ?? '?'}${b.version ? `, Version ${b.version}` : ''}` : 'no file in bitcoin/bips'}`);
      continue;
    }
    if (a.present !== b.present) {
      add('bips', b.present ? 'bip-appeared' : 'bip-removed', `${w.name}: ${b.present ? `\`${w.file}\` now in bitcoin/bips (Status ${b.status ?? '?'})` : `\`${w.file}\` no longer in bitcoin/bips`}`);
      continue;
    }
    if (a.status !== b.status) add('bips', 'bip-status', `${w.name}: Status ${a.status ?? '—'} → **${b.status ?? '—'}**`);
    if (a.version !== b.version) add('bips', 'bip-version', `${w.name}: Version ${a.version ?? '—'} → **${b.version ?? '—'}**`);
  }

  const prDiff = (track, label, before, after) => {
    if (after === null) return;
    if (before === null) {
      add(track, 'first-observation', `${label}: ${after.length === 0 ? 'none found' : after.map((p) => `#${p.number} (${p.state})`).join(', ')}`);
      return;
    }
    const old = new Map(before.map((p) => [p.number, p]));
    for (const p of after) {
      const o = old.get(p.number);
      if (o === undefined) add(track, 'pr-new', `${label}: new [#${p.number}](${p.url}) “${p.title}” (${p.state})`);
      else if (o.state !== p.state) add(track, 'pr-state', `${label}: [#${p.number}](${p.url}) ${o.state} → **${p.state}**`);
    }
  };
  prDiff('core', 'Bitcoin Core BIP-360 / P2MR PRs', base.corePrs ?? null, obs.corePrs);

  if (obs.shrincs !== null) {
    const bs = base.shrincs ?? null;
    prDiff('shrincs', 'SHRINCS PRs in bitcoin/bips', bs === null ? null : bs.prs, obs.shrincs.prs);
    if (bs !== null) {
      const known = new Map(bs.bips.map((f) => [f.bip, f]));
      for (const f of obs.shrincs.bips) {
        const o = known.get(f.bip);
        if (o === undefined) add('shrincs', 'bip-number', `SHRINCS draft now has a BIP file: \`${f.file}\` (BIP ${f.bip}, PR #${f.pr}, Status ${f.status ?? '?'})`);
        else if (o.status !== f.status) add('shrincs', 'bip-status', `SHRINCS BIP ${f.bip}: Status ${o.status ?? '—'} → **${f.status ?? '—'}**`);
      }
    }
  }
  return changes;
}

const prList = (prs) => (prs === null ? '_not observed (request failed)_' : prs.length === 0 ? 'none' : prs.map((p) => `[#${p.number}](${p.url}) ${p.title} (${p.state})`).join('<br>'));

/** The "Quantum readiness" issue section. */
export function quantumMarkdown(base, obs, changes) {
  const md = [];
  md.push('### Quantum readiness');
  md.push('');
  md.push(
    changes.length === 0
      ? 'No change since the recorded baseline.'
      : `**${changes.length} change(s)** since the recorded baseline (\`scripts/upstream-watch/quantum-baseline.json\`, recorded ${base.recordedAt ?? 'unknown'}).`,
  );
  md.push('');
  for (const c of changes) md.push(`- ${c.detail}`);
  if (changes.length > 0) md.push('');
  md.push('| Watched | Baseline | Now |');
  md.push('| --- | --- | --- |');
  for (const w of WATCHED_BIPS) {
    const fmt = (x) => (x === null || x === undefined ? '—' : x.present ? `Status ${x.status ?? '?'}${x.version ? ` · v${x.version}` : ''}` : 'not in bitcoin/bips');
    const now = obs.bips?.[w.bip];
    const commit = now?.lastCommit ? ` (last commit ${String(now.lastCommit.date ?? '').slice(0, 10)})` : '';
    md.push(`| ${w.name} | ${fmt(base.bips?.[w.bip])} | ${now === null ? '_request failed_' : fmt(now)}${commit} |`);
  }
  md.push(`| Bitcoin Core PRs (BIP-360 / P2MR) | ${base.corePrs === null ? '_not recorded_' : base.corePrs.length} | ${prList(obs.corePrs)} |`);
  const sh = obs.shrincs;
  const shNow = sh === null ? '_request failed_' : `${prList(sh.prs)}${sh.bips.length ? `<br>BIP files: ${sh.bips.map((f) => `\`${f.file}\` (${f.status ?? '?'})`).join(', ')}` : ''}`;
  md.push(`| SHRINCS draft BIP (bitcoin/bips PRs) | ${base.shrincs === null ? '_not recorded_' : `${base.shrincs.prs.length} PR(s)`} | ${shNow} |`);
  if (obs.errors.length > 0) {
    md.push('');
    md.push(`⚠️ Not observed this run: ${obs.errors.join('; ')}`);
  }
  md.push('');
  md.push(
    'What this means for the wallet: sends to SegWit v2 (P2MR) stay refused and P2MR receive stays off until a soft fork **activates** BIP-360 — a Status change alone does not activate anything. When activation is scheduled, flip `p2mr` to `active` in `packages/wallet-core/src/addressTypes.ts` and follow `docs/QUANTUM_READINESS.md`. To accept these observations as the new baseline, run `node scripts/upstream-watch/check.mjs --write-quantum-baseline` (or copy `quantum.json` from the run artifact) and commit it.',
  );
  return md.join('\n');
}

export function readBaseline(file = baselinePath) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Observation → baseline shape (drops volatile fields). Anything this run
 * failed to observe keeps its previous baseline value.
 */
export function toBaseline(obs, previous = { bips: {}, corePrs: null, shrincs: null }) {
  const bips = { ...previous.bips };
  for (const [k, v] of Object.entries(obs.bips)) {
    if (v !== null) bips[k] = { file: v.file, present: v.present, status: v.status, version: v.version };
  }
  return {
    recordedAt: obs.observedAt.slice(0, 10),
    bips,
    corePrs: obs.corePrs ?? previous.corePrs ?? null,
    shrincs: obs.shrincs ?? previous.shrincs ?? null,
  };
}

export function writeBaseline(obs, previous, file = baselinePath) {
  writeFileSync(file, `${JSON.stringify(toBaseline(obs, previous), null, 2)}\n`);
}

/**
 * Import-isolation test: the Wavelength SDK may be declared and imported ONLY
 * inside `services/wavelength-adapter`.
 *
 * The ESLint `no-restricted-imports` guard enforces this per-file at lint
 * time; this test enforces it structurally at test time (belt and suspenders):
 * it scans every workspace package.json and source file for the SDK package.
 * A violation anywhere fails CI — the isolation promise is load-bearing for
 * the spec's risk mitigation (Wavelength v0.2.0 APIs are unstable).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SDK_PACKAGE = '@lightninglabs/wavelength-core';
const SDK_SCOPE_PREFIX = '@lightninglabs/wavelength';
const ADAPTER_DIR = 'services/wavelength-adapter';

/** Workspace package directories, derived from pnpm-workspace.yaml's globs. */
function workspacePackageDirs(): string[] {
  const dirs: string[] = [];
  const yaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/- '([^']+\/\*)'/gu)].map((m) => m[1] ?? '');
  for (const glob of globs) {
    const base = glob.replace(/\/\*$/u, '');
    for (const name of readdirSync(join(REPO_ROOT, base))) {
      const dir = `${base}/${name}`;
      if (statSync(join(REPO_ROOT, dir)).isDirectory()) dirs.push(dir);
    }
  }
  return dirs.sort();
}

/** Every file under `dir` whose name matches the filter, recursively. */
function walkFiles(dir: string, suffixes: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkFiles(path, suffixes));
    else if (suffixes.some((s) => name.endsWith(s))) out.push(path);
  }
  return out;
}

/** True when the line is an import/export-from or dynamic import of the SDK. */
function isSdkImport(line: string): boolean {
  const importFrom = /from\s+['"]@lightninglabs\/wavelength/u;
  const dynamic = /import\(\s*['"]@lightninglabs\/wavelength/u;
  const bareImport = /^\s*import\s+['"]@lightninglabs\/wavelength/u;
  const requireCall = /require\(\s*['"]@lightninglabs\/wavelength/u;
  return importFrom.test(line) || dynamic.test(line) || bareImport.test(line) || requireCall.test(line);
}

describe('Wavelength SDK import isolation', () => {
  it('declares the SDK dependency in exactly one package', () => {
    const offenders: string[] = [];
    for (const dir of workspacePackageDirs()) {
      const pkgPath = join(REPO_ROOT, dir, 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        const declares = [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
          ...Object.keys(pkg.peerDependencies ?? {}),
        ].some((name) => name.startsWith(SDK_SCOPE_PREFIX));
        if (declares && dir !== ADAPTER_DIR) offenders.push(dir);
      } catch {
        // Not every workspace directory is a package (no package.json) — skip.
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('imports the SDK only from the adapter', () => {
    const offenders: { file: string; lines: number[] }[] = [];
    for (const dir of workspacePackageDirs()) {
      const srcDir = join(REPO_ROOT, dir, 'src');
      let files: string[];
      try {
        files = walkFiles(srcDir, ['.ts', '.tsx', '.js', '.jsx']);
      } catch {
        continue; // No src directory in this workspace member.
      }
      for (const file of files) {
        const rel = relative(REPO_ROOT, file);
        const lines = readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => (isSdkImport(line) ? i + 1 : 0))
          .filter((n) => n > 0);
        // The adapter's facade MAY import the SDK; the isolation test itself
        // names the package in its constants. Every other file may not.
        const selfExempt =
          rel === `${ADAPTER_DIR}/src/sdk/index.ts` ||
          rel === `${ADAPTER_DIR}/src/isolation.test.ts`;
        if (lines.length > 0 && !selfExempt) {
          offenders.push({ file: rel, lines });
        }
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it('keeps the SDK off the adapter’s public runtime imports', () => {
    // The public surface re-exports SDK VALUES only through the facade file;
    // this pins that the facade stays the single runtime-contact file.
    const facade = join(REPO_ROOT, ADAPTER_DIR, 'src/sdk/index.ts');
    expect(readFileSync(facade, 'utf8')).toContain(SDK_PACKAGE);
    const index = readFileSync(join(REPO_ROOT, ADAPTER_DIR, 'src/index.ts'), 'utf8');
    expect(index).not.toContain(SDK_PACKAGE);
  });
});

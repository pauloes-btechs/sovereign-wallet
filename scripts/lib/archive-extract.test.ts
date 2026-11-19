import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script module, no type declarations
import { extractCommand } from './archive-extract.mjs';

interface Cmd {
  cmd: string;
  args: string[];
}
const pick = (opts: Record<string, unknown>): Cmd => extractCommand(opts) as Cmd;

const base = {
  archivePath: 'a.zip',
  workDir: 'out',
  member: 'wavelength-windows-amd64-v0.2.1/waved.exe',
};

describe('extractCommand', () => {
  it('never uses PowerShell Expand-Archive for zips on a Windows host (regression: windows-2025-vs2026 image)', () => {
    const c = pick({ ...base, hostPlatform: 'win32', systemRoot: 'C:\\Windows', isZip: true });
    expect(c.cmd).toBe('C:\\Windows\\System32\\tar.exe');
    expect(c.args).toEqual(['-xf', 'a.zip', '-C', 'out', base.member]);
    expect(JSON.stringify(c)).not.toMatch(/Expand-Archive|powershell/i);
  });

  it('pins the System32 bsdtar so a GNU tar on PATH cannot shadow it', () => {
    const c = pick({ ...base, hostPlatform: 'win32', systemRoot: 'D:\\WINDOWS', isZip: true });
    expect(c.cmd).toBe('D:\\WINDOWS\\System32\\tar.exe');
    const fallback = pick({ ...base, hostPlatform: 'win32', isZip: true });
    expect(fallback.cmd).toBe('C:\\Windows\\System32\\tar.exe');
  });

  it('normalizes backslashes in the member path to archive-style slashes', () => {
    const c = pick({ ...base, member: 'dir\\waved.exe', hostPlatform: 'win32', isZip: true });
    expect(c.args.at(-1)).toBe('dir/waved.exe');
  });

  it('uses bsdtar on macOS and unzip on Linux for zips (GNU tar cannot read zip)', () => {
    expect(pick({ ...base, hostPlatform: 'darwin', isZip: true }).cmd).toBe('tar');
    const linux = pick({ ...base, hostPlatform: 'linux', isZip: true });
    expect(linux).toEqual({ cmd: 'unzip', args: ['-o', '-q', 'a.zip', base.member, '-d', 'out'] });
  });

  it('uses tar -xzf for .tar.gz on every host', () => {
    for (const hostPlatform of ['linux', 'darwin', 'win32']) {
      const c = pick({ ...base, member: 'd/waved', hostPlatform, isZip: false });
      expect(c).toEqual({ cmd: 'tar', args: ['-xzf', 'a.zip', '-C', 'out', 'd/waved'] });
    }
  });
});

describe('extractCommand on this host (real extraction)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'archive-extract-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('extracts one member from a real zip and a real tar.gz', () => {
    const src = path.join(dir, 'src');
    const inner = 'pkg-v1';
    mkdirSync(path.join(src, inner), { recursive: true });
    writeFileSync(path.join(src, inner, 'waved'), 'binary');
    writeFileSync(path.join(src, inner, 'README'), 'other');

    const tgz = path.join(dir, 'a.tar.gz');
    expect(spawnSync('tar', ['-czf', tgz, '-C', src, inner]).status).toBe(0);
    const zip = path.join(dir, 'a.zip');
    const zipped =
      process.platform === 'win32'
        ? spawnSync(`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe`, ['-a', '-cf', zip, '-C', src, inner])
        : process.platform === 'darwin'
          ? spawnSync('tar', ['-a', '-cf', zip, '-C', src, inner])
          : spawnSync('zip', ['-q', '-r', zip, inner], { cwd: src });
    expect(zipped.status).toBe(0);

    for (const [archivePath, isZip] of [
      [tgz, false],
      [zip, true],
    ] as const) {
      const out = mkdtempSync(path.join(dir, 'out-'));
      const { cmd, args } = pick({
        hostPlatform: process.platform,
        systemRoot: process.env.SystemRoot,
        archivePath,
        workDir: out,
        member: `${inner}/waved`,
        isZip,
      });
      const r = spawnSync(cmd, args);
      expect(r.status, `${cmd} ${args.join(' ')}: ${String(r.stderr)}`).toBe(0);
      expect(readFileSync(path.join(out, inner, 'waved'), 'utf8')).toBe('binary');
      expect(existsSync(path.join(out, inner, 'README'))).toBe(false);
    }
  });
});

/**
 * Archive extraction command selection for the sidecar fetch scripts.
 *
 * Windows targets ship as .zip. We extract them with bsdtar, which reads zip
 * and ships with Windows 10+ as %SystemRoot%\System32\tar.exe (and is the
 * default `tar` on macOS). We deliberately do NOT use PowerShell's
 * Expand-Archive: on the windows-2025-vs2026 runner image (2026-11) it throws
 * "Cannot find an overload for ExtractToDirectory" as a non-terminating error,
 * exits 0, and leaves no files behind. The System32 path is used explicitly
 * so a GNU tar earlier on PATH (Git for Windows, MSYS) cannot shadow it, since
 * GNU tar cannot read zip.
 *
 * @param {{ hostPlatform: string, systemRoot?: string, archivePath: string,
 *           workDir: string, member: string, isZip: boolean }} opts
 * @returns {{ cmd: string, args: string[] }}
 */
export function extractCommand({ hostPlatform, systemRoot, archivePath, workDir, member, isZip }) {
  // Archive members always use forward slashes, whatever the host.
  const entry = member.split('\\').join('/');
  if (!isZip) {
    return { cmd: 'tar', args: ['-xzf', archivePath, '-C', workDir, entry] };
  }
  if (hostPlatform === 'win32') {
    const root = systemRoot && systemRoot.length > 0 ? systemRoot : 'C:\\Windows';
    return { cmd: `${root}\\System32\\tar.exe`, args: ['-xf', archivePath, '-C', workDir, entry] };
  }
  // macOS: `tar` is bsdtar. Linux: GNU tar cannot read zip, so use unzip.
  if (hostPlatform === 'darwin') {
    return { cmd: 'tar', args: ['-xf', archivePath, '-C', workDir, entry] };
  }
  return { cmd: 'unzip', args: ['-o', '-q', archivePath, entry, '-d', workDir] };
}

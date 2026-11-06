/**
 * QR matrix generation — pure, local, no network. Uses `qrcode-generator`
 * (pinned 1.4.4, the same library and version desktop renders with).
 */

import qrcode from 'qrcode-generator';

/** The quiet zone the QR spec requires around the symbol, in modules. */
export const QR_QUIET_ZONE_MODULES = 4;

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  readonly size: number;
  /** Row-major: `rows[r][c]` is true for a dark module. */
  readonly rows: readonly (readonly boolean[])[];
}

/**
 * Encodes `payload` verbatim (byte mode, smallest version that fits).
 * Error correction M matches desktop. Throws when the payload is too long
 * for any QR version.
 */
export function qrMatrix(payload: string, errorCorrection: QrErrorCorrection = 'M'): QrMatrix {
  const qr = qrcode(0, errorCorrection);
  qr.addData(payload);
  qr.make();
  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c += 1) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return { size, rows };
}

/** A horizontal run of dark modules: start column and length. */
export interface QrRun {
  readonly start: number;
  readonly length: number;
}

/**
 * Dark modules of one row merged into runs, so a renderer draws one View
 * per run instead of one per module (a v10 code drops from ~1,700 views
 * to a few hundred).
 */
export function darkRuns(row: readonly boolean[]): QrRun[] {
  const runs: QrRun[] = [];
  let start = -1;
  for (let c = 0; c <= row.length; c += 1) {
    const dark = c < row.length && row[c] === true;
    if (dark && start < 0) start = c;
    if (!dark && start >= 0) {
      runs.push({ start, length: c - start });
      start = -1;
    }
  }
  return runs;
}

/**
 * Byte <-> hex helpers for the litd/LND wire surface (public keys, macaroons).
 * Pure so they stay trivially testable.
 */

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex string');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

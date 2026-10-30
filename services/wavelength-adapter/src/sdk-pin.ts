/**
 * The Wavelength SDK pin (spec: Mode A). Exact versions — never ranges —
 * because Wavelength v0.2.0 APIs are explicitly unstable and every consumed
 * name is golden-tested (see sdk-golden.test.ts). A version bump is a
 * deliberate, reviewed re-pin, not a routine dependency update.
 */

/** The npm package whose surface this adapter consumes. */
export const SDK_PACKAGE = '@lightninglabs/wavelength-core';

/** Exact pinned version of {@link SDK_PACKAGE}. Mirrored in package.json. */
export const SDK_PIN = '0.2.0';

/**
 * The daemon build the pinned SDK release is paired with. Asserted in the
 * golden test against the SDK's own RUNTIME_MANIFEST_VERSION constant, so a
 * package bump that changes the paired daemon fails CI until re-pinned.
 */
export const WAVELENGTH_DAEMON_PIN = 'v0.2.0';

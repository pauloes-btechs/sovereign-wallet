/**
 * Device services the host injects (native shell or web preview). Every
 * member is optional: an absent service is reported as unavailable by
 * `capabilities.ts`, and screens hide or explain the control — they never
 * render a button that does nothing.
 *
 * No native module is wired yet (see docs/MOBILE_PARITY_MATRIX.md,
 * "Remaining gaps"); the web preview supplies only `copyText`.
 */
export interface PlatformServices {
  /** Writes text to the system clipboard. */
  readonly copyText?: (text: string) => Promise<void>;
  /** Opens the system share sheet with the text. */
  readonly shareText?: (text: string) => Promise<void>;
  /** Opens the camera QR scanner; resolves the decoded text, or null if cancelled. */
  readonly scanQrCode?: () => Promise<string | null>;
  /** Light confirmation haptic. */
  readonly hapticConfirm?: () => void;
  /** Platform keystore / keychain for secrets (PIN hash, session material). */
  readonly secureStorage?: SecureStoragePort;
  /**
   * Biometric prompt; resolves true on success. Must never enroll anything:
   * where it is backed by a keystore gate it passes only against a gate the
   * app lock created (`biometricGate.create`).
   */
  readonly authenticateBiometric?: (reason: string) => Promise<boolean>;
  /**
   * Keystore-bound biometric gate (native). The app lock creates it only
   * when biometric unlock is turned on with the PIN, and treats a missing
   * gate (biometric enrollment changed) as "biometric unlock is off".
   */
  readonly biometricGate?: BiometricGate;
  /** Hides window contents from screenshots and the app switcher. */
  readonly setScreenCaptureProtection?: (enabled: boolean) => Promise<void>;
  /**
   * Bottom safe-area inset in points (home indicator / gesture bar). The
   * native shell reads it from its safe-area module; absent = 0.
   */
  readonly bottomInset?: number;
}

/** Keychain (iOS) / Keystore-backed storage (Android). Interface only today. */
export interface SecureStoragePort {
  /**
   * Where items actually live, so security screens can say it plainly:
   * `device-keystore` = iOS Keychain / Android Keystore (src/native);
   * `browser-preview` = the web preview's localStorage — NOT secure;
   * `memory` = this session only (tests). Absent = treat as `memory`.
   */
  readonly protection?: SecureStorageProtection;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type SecureStorageProtection = 'device-keystore' | 'browser-preview' | 'memory';

/** No device services — what native builds have until a resolver is wired. */
export const NO_PLATFORM_SERVICES: PlatformServices = Object.freeze({});

/** Result of a biometric check against the keystore gate. */
export type BiometricCheck =
  | 'passed'
  /** Cancelled, failed, or no biometrics enrolled. */
  | 'failed'
  /** The gate does not exist: never created, or invalidated by an enrollment change. */
  | 'gate-missing';

export interface BiometricGate {
  /** (Re)creates the gate bound to the enrolled biometrics and checks it once. Only after the PIN was entered. */
  create(reason: string): Promise<boolean>;
  /** Prompts against the existing gate. Never creates it. */
  verify(reason: string): Promise<BiometricCheck>;
  /** Deletes the gate (biometric unlock turned off). */
  remove(): Promise<void>;
}

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
  /** Biometric prompt; resolves true on success. */
  readonly authenticateBiometric?: (reason: string) => Promise<boolean>;
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
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** No device services — what native builds have until a resolver is wired. */
export const NO_PLATFORM_SERVICES: PlatformServices = Object.freeze({});

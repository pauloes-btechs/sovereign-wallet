/**
 * QR code drawn with React Native Views (no SVG or native module): one row
 * View per module row, one View per horizontal run of dark modules.
 *
 * Dark-on-light with the spec's 4-module quiet zone so phone cameras scan
 * it on the dark theme. The image carries an accessible label; the encoded
 * text is always shown beneath it (selectable) with a Copy button when the
 * host provides a clipboard — scanning is never the only way to get it.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { sovlColors, sovlRadius, sovlSpace } from '@sovereign/ui/tokens';
import { QR_QUIET_ZONE_MODULES, darkRuns, qrMatrix } from './qr.js';
import { usePlatformServices } from './appContext.js';
import { MobileButton, styles as base } from './Primitives.js';

const palette = sovlColors;

export function QrCode({
  value,
  copyValue,
  label,
  size = 232,
  showText = true,
  textLabel,
}: {
  /** Encoded verbatim (e.g. `bitcoin:` URI, `lightning:` invoice). */
  value: string;
  /** The text shown and copied, when it differs from the encoded URI (the bare address/invoice). */
  copyValue?: string;
  /** Accessible name of the image, e.g. "QR code for your Lightning invoice". */
  label: string;
  /** Rendered width/height in points, quiet zone included. */
  size?: number;
  /** Show the copyable text under the code (default true). */
  showText?: boolean;
  /** Caption above the text, e.g. "Invoice". Defaults to none. */
  textLabel?: string;
}): ReactNode {
  const { copyText } = usePlatformServices();
  const text = copyValue ?? value;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const matrix = useMemo(() => {
    try {
      return qrMatrix(value);
    } catch {
      return null; // too long for any QR version — the text fallback still works
    }
  }, [value]);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);
  useEffect(() => setCopyState('idle'), [text]);

  const modulesWithQuiet = matrix === null ? 0 : matrix.size + QR_QUIET_ZONE_MODULES * 2;
  // Whole-point modules keep edges crisp; the remainder becomes extra quiet zone.
  const cell = matrix === null ? 0 : Math.max(1, Math.floor(size / modulesWithQuiet));
  const padding = matrix === null ? 0 : Math.floor((size - cell * matrix.size) / 2);

  return (
    <View style={styles.wrap}>
      {matrix !== null ? (
        <View
          style={[styles.code, { width: size, height: size, padding }]}
          accessible
          accessibilityRole="image"
          accessibilityLabel={label}
        >
          {matrix.rows.map((row, r) => (
            <View
              key={r}
              style={{ height: cell, width: cell * matrix.size, flexDirection: 'row' }}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {darkRuns(row).map((run) => (
                <View
                  key={run.start}
                  style={{
                    position: 'absolute',
                    left: run.start * cell,
                    width: run.length * cell,
                    height: cell,
                    backgroundColor: palette.bg,
                  }}
                />
              ))}
            </View>
          ))}
        </View>
      ) : (
        <Text style={base.errorNote} accessibilityRole="alert">
          This is too long to show as a QR code. Copy the text below instead.
        </Text>
      )}
      {showText && (
        <View style={styles.textBlock}>
          {textLabel !== undefined && <Text style={base.overline}>{textLabel}</Text>}
          <Text style={[base.value, base.mono, styles.payload]} selectable>
            {text}
          </Text>
          {copyText !== undefined ? (
            <MobileButton
              label={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed — try again' : 'Copy'}
              kind="secondary"
              compact
              onPress={() => {
                copyText(text).then(
                  () => setCopyState('copied'),
                  () => setCopyState('failed'),
                );
              }}
            />
          ) : (
            <Text style={base.faint}>Select the text above to copy it.</Text>
          )}
          {copyState === 'copied' && (
            <Text style={base.faint} accessibilityLiveRegion="polite" role="status">
              Copied to the clipboard.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: sovlSpace[3] },
  code: { backgroundColor: palette.text, borderRadius: sovlRadius.sm },
  textBlock: { alignSelf: 'stretch', gap: sovlSpace[2] },
  payload: { lineHeight: 18 },
});

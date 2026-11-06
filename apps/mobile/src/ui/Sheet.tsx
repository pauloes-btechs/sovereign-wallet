/**
 * Bottom sheet — a modal panel that slides up over the current screen, for
 * contextual detail (transaction receipts, fee settings, confirmations).
 *
 * Closing: the Close button, a tap on the backdrop (unless `dismissable` is
 * false), Android back (Modal `onRequestClose`), and Escape on web
 * (react-native-web's Modal, which also renders the dialog role and
 * aria-modal). Focus: react-native-web traps focus inside the modal and
 * restores it on close; on iOS the panel is marked
 * `accessibilityViewIsModal` so VoiceOver ignores the screen behind it.
 *
 * Money-moving confirmations should pass `dismissable={false}` while a
 * payment is in flight so a stray tap cannot hide its progress.
 */

import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { sovlColors, sovlFontFamily, sovlFontSize, sovlRadius, sovlSpace } from '@sovereign/ui/tokens';
import { MIN_TOUCH_TARGET } from './navigationUi.js';

const palette = sovlColors;
const fontSans = Platform.select<string | undefined>({ web: sovlFontFamily.sans, default: undefined });

export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
  dismissable = true,
  bottomInset = 0,
  animated = true,
}: {
  open: boolean;
  /** Also the dialog's accessible name. */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned below the scrolling body (primary actions). */
  footer?: ReactNode;
  /** False hides the Close button and ignores backdrop/back/Escape. */
  dismissable?: boolean;
  bottomInset?: number;
  /** False opens without the slide (reduce-motion preference, tests). */
  animated?: boolean;
}): ReactNode {
  const requestClose = (): void => {
    if (dismissable) onClose();
  };
  return (
    <Modal
      visible={open}
      transparent
      animationType={animated ? 'slide' : 'none'}
      onRequestClose={requestClose}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={requestClose}
          accessible={false}
          focusable={false}
          importantForAccessibility="no"
          aria-hidden
        />
        <View
          style={[styles.panel, { paddingBottom: Math.max(bottomInset, sovlSpace[4]) }]}
          accessibilityViewIsModal
          accessibilityLabel={title}
        >
          <View style={styles.grabber} accessibilityElementsHidden importantForAccessibility="no" aria-hidden />
          <View style={styles.head}>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            {dismissable && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={onClose}
                style={styles.close}
                hitSlop={4}
              >
                <Text style={styles.closeGlyph} accessibilityElementsHidden importantForAccessibility="no" aria-hidden>
                  ×
                </Text>
              </Pressable>
            )}
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyInner}>
            {children}
          </ScrollView>
          {footer !== undefined && <View style={styles.footer}>{footer}</View>}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.6)' },
  panel: {
    backgroundColor: palette.surfaceRaised,
    borderTopLeftRadius: sovlRadius.md * 1.5,
    borderTopRightRadius: sovlRadius.md * 1.5,
    borderColor: palette.border,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: '88%',
    paddingHorizontal: sovlSpace[4],
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.borderStrong,
    marginTop: sovlSpace[2],
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET + sovlSpace[2],
    gap: sovlSpace[3],
  },
  title: { fontFamily: fontSans, color: palette.text, fontSize: sovlFontSize.lg, fontWeight: '600', flexShrink: 1 },
  close: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: MIN_TOUCH_TARGET / 2,
    marginRight: -sovlSpace[2],
  },
  closeGlyph: { fontFamily: fontSans, color: palette.textSecondary, fontSize: 26, lineHeight: 28 },
  body: { flexGrow: 0 },
  bodyInner: { gap: sovlSpace[3], paddingBottom: sovlSpace[3] },
  footer: { gap: sovlSpace[2], paddingTop: sovlSpace[2] },
});

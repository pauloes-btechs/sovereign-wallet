/**
 * Scaffold placeholder. Mode A (Wavelength, native bindings) and Mode B
 * (LNC pairing to the user's own litd) arrive with the mobile tasks.
 * New Architecture is the default in React Native 0.76 — required here.
 */
import { Text, View } from 'react-native';

export default function App() {
  return (
    <View style={{ flex: 1, backgroundColor: '#0d0d10', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#e8e8ea', fontSize: 20 }}>Sovereign Wallet</Text>
      <Text style={{ color: '#a0a0a8', marginTop: 8 }}>Noncustodial Bitcoin &amp; Lightning — scaffold build.</Text>
    </View>
  );
}

/**
 * RN entry point — registered by native shells (iOS/Android) generated in a
 * later task. The scaffold typechecks and is CI-tested; native projects are
 * not committed.
 */
import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';
import App from './src/App';

AppRegistry.registerComponent(appName, () => App);

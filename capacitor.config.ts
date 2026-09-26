import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = { appId: 'com.prdoring.museamo', appName: 'Museamo', webDir: 'dist', android: { minWebViewVersion: 105 }, server: { androidScheme: 'https', hostname: 'com.prdoring.museamo' } };
export default config;

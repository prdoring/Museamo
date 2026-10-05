import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { watch: { ignored: ['**/android/**', '**/desktop/**', '**/crates/**', '**/target/**', '**/artifacts/**', '**/.tools/**'] } },
  // Tailwind 4 needs Chrome 111 / Safari 16.4. Linux bundles require updated WebKitGTK.
  build: { target: ['chrome111', 'safari16.4'], cssTarget: ['chrome111', 'safari16.4'] },
  // Ignore copied verification workspaces and the separate Node release-tooling suite.
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});

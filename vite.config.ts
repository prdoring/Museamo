import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { watch: { ignored: ['**/android/**', '**/desktop/**', '**/crates/**', '**/target/**', '**/artifacts/**', '**/.tools/**'] } },
  build: { target: 'chrome105' },
  // Ignore copied verification workspaces and the separate Node release-tooling suite.
  test: { include: ['src/**/*.test.{ts,tsx}'] },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { watch: { ignored: ['**/android/**', '**/desktop/**', '**/crates/**', '**/target/**', '**/artifacts/**', '**/.tools/**'] } },
  build: { target: 'chrome105' },
});

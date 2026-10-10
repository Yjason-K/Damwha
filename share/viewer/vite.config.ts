import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // CSP가 inline 스크립트를 막는다 — modulepreload 폴리필(inline)을 넣지 않는다.
  build: { outDir: '../dist/viewer', emptyOutDir: true, modulePreload: { polyfill: false } },
});

import { defineConfig } from 'vite';
export default defineConfig({
  root: 'desktop/renderer', base: './',
  build: { outDir: '../../build/renderer', emptyOutDir: true },
  server: { port: 5179, strictPort: true }
});

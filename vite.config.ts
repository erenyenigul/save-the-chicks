import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the site from /<repo>/.
  base: command === 'build' ? '/save-the-chicks/' : '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
}));

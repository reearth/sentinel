import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    outDir: './dist',
    emptyOutDir: false,  // Don't clear dist - library files are already there
    sourcemap: true,
  },
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: './src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        injectionPoint: undefined,
      },
    }),
  ],
});


/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  build: {
    outDir: './dist',
    emptyOutDir: false,  // Don't clear dist - library files are already there
    sourcemap: true,
    lib: {
      entry: './src/sw.ts',
      formats: ['es'],
      fileName: () => 'sw.js',
    },
    rollupOptions: {
      external: [],
    },
  },
});


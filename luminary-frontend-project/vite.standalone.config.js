import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build profile for the single-file portable demo.
 *
 * Two deliberate differences from the normal build:
 *  - `format: 'iife'` emits a classic script rather than an ES module, because
 *    browsers block `type="module"` over the file:// protocol (CORS). A classic
 *    script runs fine from a double-clicked file.
 *  - Everything is forced into one chunk with CSS un-split, so the inliner in
 *    scripts/inline-standalone.mjs has exactly one JS and one CSS file to fold in.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist-standalone',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000, // inline every asset as a data URI
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});

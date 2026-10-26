import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// The extension loads dist/webview/index.js and index.css by name, so the file names carry no hash.
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    // One bundle for all views, loaded from disk: CodeMirror with its SQL, JSON and JavaScript grammars and the
    // MySQL, Redis, Kafka and MongoDB screens make it about 1.1 MB. Splitting it would need 'strict-dynamic' in the CSP.
    chunkSizeWarningLimit: 1536,
    rollupOptions: {
      // index.html is only the dev server page; the extension renders its own.
      input: 'src/main.ts',
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: '[name].js',
        assetFileNames: (asset) => (asset.names.some((n) => n.endsWith('.css')) ? 'index.css' : '[name][extname]'),
      },
    },
  },
});

import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

/** @platformatic/wasm-utils reads native.wasm next to itself; its `bundled` build carries the module inline. */
const wasmUtilsBundled = {
  name: 'wasm-utils-bundled',
  setup(build) {
    build.onResolve({ filter: /^@platformatic\/wasm-utils$/ }, async (args) => {
      if (args.pluginData === 'skip') return undefined;
      const resolved = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: 'skip' });
      return { path: join(dirname(resolved.path), 'bundled.js') };
    });
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // The Node.js inside VS Code 1.105 (Electron 37), not the Node.js used for development.
  target: 'node22',
  // ssh2, @platformatic/kafka, mongodb and pg load these optional add-ons inside try/catch and do without them:
  // native modules (pg-native is pg's libpq binding), and the MongoDB driver's Kerberos, cloud credential and
  // compression plug-ins.
  external: [
    'vscode',
    'cpu-features',
    'pg-native',
    '@node-rs/crc32',
    'kerberos',
    'snappy',
    'socks',
    'gcp-metadata',
    '@mongodb-js/zstd',
    '@aws-sdk/credential-providers',
    'mongodb-client-encryption',
  ],
  // @platformatic/kafka is an ES module that calls createRequire(import.meta.url) when it loads.
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  plugins: [wasmUtilsBundled],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const context = await esbuild.context(
  tests
    ? { ...shared, entryPoints: ['test/e2e/*.test.ts'], outdir: 'out/test' }
    : { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
);

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}

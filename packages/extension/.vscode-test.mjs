import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// Runs out/test (built by `node esbuild.mjs --tests`) inside VS Code against the servers in docker/.
// Set VSCODE_TEST_PATH to an installed VS Code binary to skip the download.
export default defineConfig({
  files: 'out/test/**/*.test.js',
  extensionDevelopmentPath: '.',
  // A short profile path: the IPC socket path inside it must stay under 104 characters on macOS.
  launchArgs: ['--disable-extensions', `--user-data-dir=${join(tmpdir(), 'datakit-e2e')}`],
  mocha: { ui: 'tdd', timeout: 60_000 },
  ...(process.env.VSCODE_TEST_PATH ? { useInstallation: { fromPath: process.env.VSCODE_TEST_PATH } } : {}),
});

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || path.resolve('.cache/electron-builder') }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

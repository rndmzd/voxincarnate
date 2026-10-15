import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('electron/install.js')], {
  stdio: 'inherit', env: { ...process.env, electron_config_cache: process.env.electron_config_cache || path.resolve('.electron-cache') }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

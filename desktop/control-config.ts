import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONTROL_PORT, defaultHotkeys, parseControlSettings, type ControlConfig } from './control-protocol.js';

export function freshControlConfig(enabled = true): ControlConfig {
  return { version: 1, enabled, port: CONTROL_PORT, token: randomBytes(32).toString('hex'), hotkeys: defaultHotkeys() };
}

export class ControlConfigStore {
  readonly filename: string;
  constructor(dataDir: string) { this.filename = path.join(dataDir, 'controls.json'); }
  async load(): Promise<ControlConfig> {
    let source: string;
    try { source = await fs.readFile(this.filename, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const config = freshControlConfig();
      await this.save(config); return config;
    }
    const parsed = JSON.parse(source) as ControlConfig;
    if (parsed.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.token)) throw new Error('Invalid controls.json. Preserve it and correct its version or connection token.');
    return { version: 1, token: parsed.token, ...parseControlSettings(parsed) };
  }
  async save(config: ControlConfig): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    const temp = `${this.filename}.${randomBytes(8).toString('hex')}.tmp`;
    try { await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, this.filename); }
    finally { await fs.unlink(temp).catch(() => undefined); }
  }
}

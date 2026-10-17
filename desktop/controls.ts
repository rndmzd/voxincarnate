import { EventEmitter } from 'node:events';
import { ControlConfigStore, freshControlConfig } from './control-config.js';
import { ControlServer } from './control-server.js';
import { commandIssue, EMPTY_RUNTIME, parseCommand, parseControlSettings, type ControlCommand, type ControlConfig, type ControlInfo, type ControlResponse, type ControlResult, type ControlRuntime, type ControlSettings, type ControlState } from './control-protocol.js';

export interface ShortcutDriver {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}
export class Controls extends EventEmitter {
  private config!: ControlConfig;
  private server?: ControlServer;
  private runtime: ControlRuntime = { ...EMPTY_RUNTIME };
  private revision = 0;
  private registered: string[] = [];
  private hotkeyErrors: Record<string, string> = {};
  private error?: string;
  private saving = false;
  private pending = new Set<Promise<ControlResult>>();
  private closed = false;
  constructor(private configStore: ControlConfigStore, private shortcuts: ShortcutDriver,
    private characters: () => ControlState['characters'], private invoke: (command: ControlCommand) => Promise<ControlResult>) { super(); }

  async start(): Promise<void> {
    try { this.config = await this.configStore.load(); }
    catch {
      this.config = freshControlConfig(false);
      this.error = 'Control settings could not be loaded. The existing file was preserved. Save this panel to replace it with the settings shown here.';
      this.refresh(); return;
    }
    this.hotkeyErrors = this.register(this.config);
    try { this.server = await this.listen(this.config); }
    catch { this.error = `Control port ${this.config.port} is unavailable. Choose another port in Stream Deck & hotkeys.`; }
    this.refresh();
  }
  info(): ControlInfo {
    return { settings: structuredClone({ enabled: this.config.enabled, port: this.config.port, hotkeys: this.config.hotkeys }),
      token: this.config.token, listening: !!this.server, error: this.error, hotkeyErrors: { ...this.hotkeyErrors } };
  }
  state(): ControlState {
    return { ...structuredClone(this.runtime), busy: this.runtime.busy || this.pending.size > 0, apiVersion: 1, revision: this.revision, characters: this.characters() };
  }
  update(runtime: ControlRuntime): void { this.runtime = structuredClone(runtime); this.refresh(); }
  unavailable(): void { this.update({ ...EMPTY_RUNTIME }); }
  refresh(): void { ++this.revision; this.server?.broadcast(); this.emit('state', this.state()); }

  async execute(value: unknown): Promise<ControlResponse> {
    let command: ControlCommand;
    try { command = parseCommand(value); }
    catch (error) { return { ok: false, code: 'invalid_command', message: (error as Error).message, state: this.state() }; }
    const issue = commandIssue(this.state(), command);
    if (issue) { this.emit('result', issue); return { ...issue, state: this.state() }; }
    if (command.action === 'audio.start' && this.runtime.running) return { ok: true, state: this.state() };
    // Do not queue presses: a delayed entrance or toggle can be surprising on air.
    const task = Promise.resolve().then(() => this.invoke(command)).catch((): ControlResult => ({ ok: false, code: 'studio_unavailable', message: 'The studio could not complete the command. Reopen it and try again.' }));
    this.pending.add(task); this.refresh();
    void task.finally(() => { this.pending.delete(task); if (!this.closed) this.refresh(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ControlResult>(resolve => { timer = setTimeout(() => resolve({ ok: false, code: 'timeout', message: 'The command has not finished. Check the studio before retrying.' }), 20000); });
    const result = await Promise.race([task, timeout]);
    clearTimeout(timer);
    this.emit('result', result);
    return { ...result, state: this.state() };
  }
  async save(value: ControlSettings): Promise<ControlInfo> {
    if (this.saving) throw new Error('Control settings are already being saved.');
    const settings = parseControlSettings(value);
    const next: ControlConfig = { ...settings, version: 1, token: this.config.token };
    this.saving = true;
    const previous = this.config;
    let replacement: ControlServer | undefined;
    const replaceServer = settings.enabled && (!this.server || settings.port !== previous.port);
    try {
      // Reserve the new port first; a failed save keeps the old connection alive.
      if (replaceServer) replacement = await this.listen(next);
      this.unregister();
      const errors = this.register(next);
      if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
      await this.configStore.save(next);
      this.config = next; this.hotkeyErrors = {}; this.error = undefined;
      if (replacement || !settings.enabled) { const old = this.server; this.server = replacement; replacement = undefined; await old?.stop(); }
      this.refresh(); return this.info();
    } catch (error) {
      await replacement?.stop();
      this.unregister(); this.hotkeyErrors = this.register(previous);
      throw error;
    } finally { this.saving = false; }
  }
  private async listen(config: ControlConfig): Promise<ControlServer | undefined> {
    if (!config.enabled) return;
    const server = new ControlServer(config.token, () => this.state(), command => this.execute(command));
    try { await server.start(config.port); return server; }
    catch (error) { await server.stop(); throw error; }
  }
  private register(config: ControlConfig): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const binding of config.hotkeys) {
      if (!binding.accelerator) continue;
      try {
        if (this.shortcuts.register(binding.accelerator, () => { void this.execute(binding.command); })) { this.registered.push(binding.accelerator); continue; }
      } catch { /* Electron rejects invalid accelerators synchronously. */ }
      errors[binding.id] = `Shortcut ${binding.accelerator} is invalid or already used by another application. Choose another shortcut.`;
    }
    return errors;
  }
  private unregister(): void { for (const key of this.registered) this.shortcuts.unregister(key); this.registered = []; }
  async stop(): Promise<void> { this.closed = true; this.unregister(); await this.server?.stop(); this.server = undefined; }
}

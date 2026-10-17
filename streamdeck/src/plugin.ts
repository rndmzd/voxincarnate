import streamDeck, { SingletonAction, type KeyDownEvent, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent, type PropertyInspectorDidAppearEvent } from '@elgato/streamdeck';
import type { KeyAction } from '@elgato/streamdeck';
import { CONTROL_ACTIONS, commandIssue, parseCommand, type ControlAction, type ControlCommand } from '../../desktop/control-protocol.js';
import { LocalControlClient, parseConnection } from './client.js';
import { buttonImage, presentation } from './presentation.js';

type KeySettings = { characterId?: string; effect?: string };
const client = new LocalControlClient();
const keys = new Map<string, { key: KeyAction<KeySettings>; command: ControlCommand }>();
const pending = new Set<string>();
let lastResult = '';
const commandFor = (action: ControlAction, settings: KeySettings): ControlCommand => parseCommand({ action,
  ...(action.startsWith('character.') && settings.characterId ? { characterId: settings.characterId } : {}),
  ...(action.startsWith('character.') && settings.effect ? { effect: settings.effect } : {}) });

async function inspector(): Promise<void> {
  await streamDeck.ui.sendToPropertyInspector({ event: 'status', connected: !!client.state, activeCharacterId: client.state?.activeCharacterId ?? '',
    message: lastResult || client.message, characters: (client.state?.characters ?? []).map(c => ({ id: c.id, name: c.name, visible: c.visible, motions: { ...c.motions } })) });
}
async function render(): Promise<void> {
  await Promise.allSettled([...keys.values()].map(async ({ key, command }) => {
    const view = presentation(command, client.state);
    await key.setState(view.active ? 1 : 0); await key.setImage(buttonImage(view.color)); await key.setTitle(view.title);
  }));
  await inspector();
}
class VoxAction extends SingletonAction<KeySettings> {
  override readonly manifestId: string;
  constructor(private controlAction: ControlAction) { super(); this.manifestId = `com.voxincarnate.streamdeck.${controlAction}`; }
  override async onWillAppear(ev: WillAppearEvent<KeySettings>): Promise<void> {
    if (ev.action.isKey()) {
      try { keys.set(ev.action.id, { key: ev.action, command: commandFor(this.controlAction, ev.payload.settings) }); }
      catch { await ev.action.setTitle('Configure\naction'); await ev.action.showAlert(); return; }
    }
    await render();
  }
  override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void { keys.delete(ev.action.id); }
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): Promise<void> {
    if (!ev.action.isKey()) return;
    try { keys.set(ev.action.id, { key: ev.action, command: commandFor(this.controlAction, ev.payload.settings) }); }
    catch { keys.delete(ev.action.id); await ev.action.setTitle('Configure\naction'); await ev.action.showAlert(); }
    await render();
  }
  override async onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<KeySettings>): Promise<void> { await inspector(); }
  override async onKeyDown(ev: KeyDownEvent<KeySettings>): Promise<void> {
    if (pending.has(ev.action.id)) return;
    pending.add(ev.action.id); lastResult = '';
    try {
      const command = commandFor(this.controlAction, ev.payload.settings);
      const issue = client.state && commandIssue(client.state, command);
      if (issue) throw new Error(issue.message);
      const result = await client.execute(command);
      if (!result.ok) throw new Error(result.message ?? 'Check the studio before retrying.');
      lastResult = 'Command completed.'; await ev.action.showOk();
    } catch (error) { lastResult = (error as Error).message; await ev.action.showAlert(); }
    finally { pending.delete(ev.action.id); await render(); }
  }
}

client.on('state', () => { if (!client.state) lastResult = ''; void render(); });
streamDeck.ui.onSendToPlugin(async ev => {
  const payload = ev.payload as { event?: string; code?: unknown };
  if (payload.event === 'pair') {
    try {
      const connection = parseConnection(payload.code);
      await streamDeck.settings.setGlobalSettings({ ...connection });
      lastResult = ''; client.connect(connection);
    } catch { lastResult = 'Invalid connection code. Copy it from Voxincarnate → Stream Deck & hotkeys.'; }
  }
  await inspector();
});
for (const action of CONTROL_ACTIONS) streamDeck.actions.registerAction(new VoxAction(action));
await streamDeck.connect();
try { client.connect(parseConnection(await streamDeck.settings.getGlobalSettings())); }
catch { await render(); }
process.on('SIGTERM', () => { client.close(); process.exit(0); });

import { useEffect, useRef, useState } from 'react';
import type { Character, MotionEffect } from '../shared';
import { MOTION_EFFECTS, MOTION_LABELS } from '../shared';
import { ACTION_LABELS, CONTROL_ACTIONS, type ControlAction, type ControlInfo, type ControlSettings, type HotkeyBinding } from '../control-protocol';

export function ControlSettingsPanel({ characters, onClose }: { characters: Character[]; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<ControlInfo>();
  const [draft, setDraft] = useState<ControlSettings>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(info?.settings);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void window.vox!.pauseHotkeys(true);
    let disposed = false;
    window.vox!.controlInfo().then(value => { if (!disposed) { setInfo(value); setDraft(value.settings); } }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; void window.vox!.pauseHotkeys(false); focus?.focus(); };
  }, []);
  const close = () => { if (!saving && (!dirty || window.confirm('Discard unsaved control settings?'))) onClose(); };
  const patch = (value: Partial<ControlSettings>) => { setDraft(current => current && { ...current, ...value }); setNotice(''); setError(''); setRowErrors({}); };
  const row = (id: string, change: Partial<HotkeyBinding>) => patch({ hotkeys: draft!.hotkeys.map(binding => binding.id === id ? { ...binding, ...change } : binding) });
  const save = async () => {
    if (!draft) return;
    setSaving(true); setError(''); setNotice(''); setRowErrors({});
    try { const next = await window.vox!.saveControlSettings(draft); setInfo(next); setDraft(next.settings); setNotice('Control settings saved.'); }
    catch (error) {
      const message = (error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); setError(message);
      const errors: Record<string, string> = {};
      for (const binding of draft.hotkeys) {
        const key = binding.accelerator.trim().toLowerCase();
        if (key && (message.includes(binding.accelerator) || draft.hotkeys.filter(other => other.accelerator.trim().toLowerCase() === key).length > 1)) errors[binding.id] = message;
      }
      setRowErrors(errors);
    }
    finally { setSaving(false); }
  };
  const install = async () => { try { await window.vox!.installStreamDeckPlugin(); } catch (error) { setError((error as Error).message); } };
  return <dialog ref={dialog} className="control-dialog" aria-labelledby="control-title" onCancel={event => { event.preventDefault(); close(); }}>
    <form className="control-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <header className="control-heading">
        <div><h2 id="control-title">Stream Deck &amp; hotkeys</h2><p>Control audio and on-air animations from your desk.</p></div>
        <div className="control-heading-actions"><button type="submit" className="primary" disabled={!draft || saving || (!dirty && !info?.error)}>{saving ? 'Saving…' : 'Save controls'}</button><button type="button" className="secondary" disabled={saving} onClick={close}>Close</button></div>
        {(error || info?.error || notice) && <div className="control-feedback"><p className={error || info?.error ? 'inline-error' : 'control-notice'} role={error || info?.error ? 'alert' : 'status'}>{error || info?.error || notice}</p>{error && Object.keys(rowErrors).length > 0 && <button type="button" className="text-button" onClick={() => { const field = document.getElementById(`hotkey-${Object.keys(rowErrors)[0]}`); field?.scrollIntoView({ block: 'center' }); field?.focus(); }}>Show shortcut</button>}</div>}
      </header>
      <div className="control-body">
        {!draft || !info ? <p>Loading control settings…</p> : <>
          <section aria-labelledby="streamdeck-connection"><h3 id="streamdeck-connection">Connect Stream Deck</h3>
            <p className="helper">Install the Voxincarnate plugin, add an action to a key, then paste the connection code into its settings. The code connects every Voxincarnate key on this computer.</p>
            <div className="control-connection-actions"><button type="button" className="secondary" onClick={() => void install()}>Install Stream Deck plugin</button><button type="button" className="secondary" disabled={!info.listening} onClick={() => { void window.vox!.copy(JSON.stringify({ port: info.settings.port, token: info.token })).then(() => setNotice('Connection code copied. Paste it into a Voxincarnate key in Stream Deck.')).catch(error => setError(error.message)); }}>Copy connection code</button></div>
            <p className="helper">Requires Stream Deck 7.1 or newer. Keep Voxincarnate open. Website sign-in, microphone selection, and starting the assistant’s call stay in the studio.</p>
            <div className="control-api-settings"><label className="control-checkbox"><input type="checkbox" checked={draft.enabled} disabled={saving} onChange={event => patch({ enabled: event.target.checked })} />Enable local control API</label>
              <label htmlFor="control-port">Local port<input id="control-port" type="number" min={1024} max={65535} value={draft.port} disabled={saving} onChange={event => patch({ port: Number(event.target.value) })} /></label></div>
            <p className="control-connection-status" role="status">{info.listening ? `Listening on 127.0.0.1:${info.settings.port}` : 'Local API is off. Global hotkeys still work.'}</p>
          </section>
          <section aria-labelledby="global-hotkeys"><h3 id="global-hotkeys">Global hotkeys</h3>
            <p className="helper">Enter a shortcut such as <kbd>Ctrl+Alt+F9</kbd>. Blank shortcuts are off. Hotkeys work while another app has focus and are paused while this panel is open.</p>
            <p className="helper">Use separate Start and Stop actions in sequences. Refresh requires audio to be stopped. Save character changes before starting capture or an animation.</p>
            <fieldset disabled={saving} className="control-hotkey-fields"><legend className="sr-only">Hotkey assignments</legend>
              {draft.hotkeys.map((binding, index) => {
                const motion = binding.command.action.startsWith('character.');
                const kind = binding.command.action === 'character.enter' ? 'enter' : 'exit';
                const rowError = rowErrors[binding.id] || info.hotkeyErrors[binding.id];
                return <div className="control-hotkey-row" key={binding.id}>
                  <div className="control-command-fields"><label htmlFor={`hotkey-action-${binding.id}`}>Action<select id={`hotkey-action-${binding.id}`} value={binding.command.action} onChange={event => row(binding.id, { command: { action: event.target.value as ControlAction } })}>{CONTROL_ACTIONS.map(action => <option key={action} value={action}>{ACTION_LABELS[action]}</option>)}</select></label>
                    {motion && <label htmlFor={`hotkey-effect-${binding.id}`}>Animation<select id={`hotkey-effect-${binding.id}`} value={binding.command.effect ?? ''} onChange={event => row(binding.id, { command: { ...binding.command, effect: (event.target.value || undefined) as MotionEffect | undefined } })}><option value="">Saved default</option>{MOTION_EFFECTS.map(effect => <option key={effect} value={effect}>{MOTION_LABELS[kind][effect]}</option>)}</select></label>}</div>
                  <label htmlFor={`hotkey-character-${binding.id}`}>Character<select id={`hotkey-character-${binding.id}`} disabled={!motion} value={binding.command.characterId ?? ''} onChange={event => row(binding.id, { command: { ...binding.command, characterId: event.target.value || undefined } })}><option value="">Currently selected</option>{motion && characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}{motion && binding.command.characterId && !characters.some(c => c.id === binding.command.characterId) && <option value={binding.command.characterId}>Deleted character · choose another</option>}</select></label>
                  <label htmlFor={`hotkey-${binding.id}`}>Shortcut<input id={`hotkey-${binding.id}`} autoComplete="off" spellCheck={false} placeholder="Not assigned" value={binding.accelerator} aria-invalid={!!rowError} aria-describedby={rowError ? `hotkey-error-${binding.id}` : undefined} onChange={event => row(binding.id, { accelerator: event.target.value })} />{rowError && <span id={`hotkey-error-${binding.id}`} className="inline-error">{rowError}</span>}</label>
                  <button type="button" className="text-button" aria-label={`Remove hotkey ${index + 1}`} onClick={() => patch({ hotkeys: draft.hotkeys.filter(item => item.id !== binding.id) })}>Remove</button>
                </div>;
              })}
              {!draft.hotkeys.length && <p className="helper">No hotkeys assigned. Add an action to get started.</p>}
              <button type="button" className="secondary" disabled={draft.hotkeys.length >= 40} onClick={() => patch({ hotkeys: [...draft.hotkeys, { id: crypto.randomUUID(), accelerator: '', command: { action: 'audio.toggle' } }] })}>Add hotkey</button>
            </fieldset>
          </section>
        </>}
      </div>
    </form>
  </dialog>;
}

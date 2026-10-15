import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = transformSync(readFileSync(new URL('../assistant-preload.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022', keepNames: false
}).code;

function fixture(installed: unknown = { ready: true }) {
  const statuses: { error?: string; message?: string }[] = [];
  let listener: ((_event: unknown, value: unknown) => void) | undefined;
  let commandResult: unknown = true;
  let commandError: unknown;
  const electron = {
    contextBridge: { executeInMainWorld: ({ args }: { args: unknown[] }) => {
      if (args.length === 1) return installed;
      if (commandError) throw commandError;
      return commandResult;
    } },
    ipcRenderer: {
      sendSync: () => ({ enabled: false, deviceId: '' }),
      send: (_channel: string, value: typeof statuses[number]) => statuses.push(value),
      on: (_channel: string, value: typeof listener) => { listener = value; }
    }
  };
  vm.runInNewContext(source, {
    require: (name: string) => name === 'electron' ? electron : {
      installAssistantAdapter() {}, sendAssistantAdapterCommand() {}
    },
    crypto: { getRandomValues: (array: Uint32Array) => array.fill(1) },
    window: { addEventListener() {} }, Error
  });
  return {
    statuses,
    command: () => listener?.(undefined, { type: 'devices' }),
    result: (value: unknown) => { commandResult = value; },
    fail: (value: unknown) => { commandError = value; }
  };
}

test('preload forwards an explicit adapter installation error', () => {
  const f = fixture({ ready: false, error: 'Microphone APIs unavailable.' });
  assert.equal(f.statuses.at(-1)?.error, 'Microphone APIs unavailable.');
});

test('preload reports a missing page controller instead of silently losing commands', () => {
  const f = fixture();
  f.result(false);
  f.command();
  assert.match(f.statuses.at(-1)?.error || '', /adapter is unavailable/);
});

test('preload catches command execution failure without exposing page error content', () => {
  const f = fixture();
  f.fail(new TypeError('private page contents'));
  assert.doesNotThrow(() => f.command());
  assert.match(f.statuses.at(-1)?.error || '', /command failed \(TypeError\)/);
  assert.doesNotMatch(f.statuses.at(-1)?.error || '', /private page contents/);
});

test('preload accepts successful command delivery without adding an error', () => {
  const f = fixture();
  f.command();
  assert.equal(f.statuses.length, 1);
  assert.match(f.statuses[0].message || '', /adapter ready/);
  assert.equal(f.statuses[0].error, '');
});

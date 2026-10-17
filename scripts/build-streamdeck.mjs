import { build } from 'esbuild';
import { mkdir, copyFile, cp, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const output = path.resolve('build/streamdeck');
const folder = path.join(output, 'com.voxincarnate.streamdeck.sdPlugin');
await mkdir(path.join(folder, 'bin'), { recursive: true });
await mkdir(path.join(folder, 'imgs'), { recursive: true });
await cp('streamdeck/ui', path.join(folder, 'ui'), { recursive: true });
await copyFile('LICENSE', path.join(folder, 'LICENSE'));
await copyFile('streamdeck/README.md', path.join(folder, 'README.md'));
await mkdir(path.join(folder, 'third-party'), { recursive: true });
for (const [name, source] of [['streamdeck', '@elgato/streamdeck'], ['utils', '@elgato/utils'], ['schemas', '@elgato/schemas'], ['ws', 'ws']]) {
  await copyFile(`node_modules/${source}/LICENSE`, path.join(folder, `third-party/${name}-LICENSE`));
}
await writeFile(path.join(folder, 'package.json'), JSON.stringify({ type: 'module', private: true }));
await build({ entryPoints: ['streamdeck/src/plugin.ts'], outfile: path.join(folder, 'bin/plugin.js'), platform: 'node', format: 'esm', bundle: true,
  target: 'node24', banner: { js: "import { createRequire as __voxCreateRequire } from 'node:module';const require=__voxCreateRequire(import.meta.url);" } });

// Draw the same simple waveform mark as the live keys; no font or rasterizer dependency.
function crc32(bytes) { let crc = -1; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; ++i) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
function icon(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const points = [[.22,.38],[.37,.66],[.51,.28],[.65,.59],[.79,.38]];
  const distance = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const foreground = points.slice(1).some((p, i) => distance((x + .5) / size, (y + .5) / size, points[i], p) < .027);
    const color = foreground ? [141,224,195] : [23,32,38]; const offset = y * (size * 4 + 1) + 1 + x * 4;
    pixels.set([...color, 255], offset);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
for (const [name, size] of [['plugin',256],['category',28],['action',20],['key',72]]) {
  await writeFile(path.join(folder, `imgs/${name}.png`), icon(size));
  await writeFile(path.join(folder, `imgs/${name}@2x.png`), icon(size * 2));
}
const actions = [
  ['audio.start','Start audio capture'], ['audio.stop','Stop audio'], ['audio.toggle','Toggle audio'],
  ['inputs.refresh','Refresh microphone inputs'], ['character.enter','Entrance'], ['character.exit','Exit']
];
const manifest = {
  $schema: 'https://schemas.elgato.com/streamdeck/plugins/manifest.json', UUID: 'com.voxincarnate.streamdeck',
  Name: 'Voxincarnate', Author: 'Voxincarnate contributors', Description: 'Control Voxincarnate audio and on-air character animations with live state feedback.',
  Version: '1.0.0.0', SDKVersion: 3, CodePath: 'bin/plugin.js', Nodejs: { Version: '24' },
  OS: [{ Platform: 'windows', MinimumVersion: '10' }], Software: { MinimumVersion: '7.1' },
  Icon: 'imgs/plugin', Category: 'Voxincarnate', CategoryIcon: 'imgs/category', PropertyInspectorPath: 'ui/settings.html',
  Actions: actions.map(([id, name]) => ({ UUID: `com.voxincarnate.streamdeck.${id}`, Name: name, Icon: 'imgs/action',
    Tooltip: name, Controllers: ['Keypad'], SupportedInMultiActions: true, DisableAutomaticStates: true,
    States: [0, 1].map(() => ({ Image: 'imgs/key', TitleAlignment: 'bottom', FontSize: 12 })) }))
};
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
const packed = spawnSync(process.execPath, ['node_modules/@elgato/cli/bin/streamdeck.mjs', 'pack', folder, '--output', output, '--force', '--no-update-check', '--no-file-list'], { encoding: 'utf8' });
if (packed.stdout) process.stdout.write(packed.stdout);
if (packed.stderr) process.stderr.write(packed.stderr);
if (packed.error) throw packed.error;
if (packed.status !== 0) throw new Error('Stream Deck plugin validation or packaging failed.');

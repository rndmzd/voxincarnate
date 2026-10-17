import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await viteBuild();
for (const name of ['main', 'preload', 'assistant-preload']) {
  await build({ entryPoints: [`desktop/${name}.ts`], outfile: `build/${name}.cjs`,
    platform: 'node', format: 'cjs', bundle: true, external: ['electron', 'ws'], target: 'node22', sourcemap: true });
}
const notices = new URL('../build/third-party/headaudio/', import.meta.url);
await mkdir(notices, { recursive: true });
for (const filename of ['LICENSE', 'PROVENANCE.md']) {
  await copyFile(new URL(`../desktop/vendor/headaudio/${filename}`, import.meta.url), new URL(filename, notices));
}

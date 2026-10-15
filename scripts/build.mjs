import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
await viteBuild();
for (const name of ['main', 'preload', 'assistant-preload']) {
  await build({ entryPoints: [`desktop/${name}.ts`], outfile: `build/${name}.cjs`,
    platform: 'node', format: 'cjs', bundle: true, external: ['electron', 'ws'], target: 'node22', sourcemap: true });
}

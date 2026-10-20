import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { build as bundle, context } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.resolve(root, 'extension');
if (path.dirname(destination) !== root || path.basename(destination) !== 'extension')
  throw new Error('Refusing to build outside the Relay extension directory.');
const watch = process.argv.includes('--watch');
// This is generated output, bounded to the verified extension directory above.
await fs.mkdir(destination, { recursive: true });
await viteBuild({root, base:'./', build:{outDir:destination, emptyOutDir:true, ...(watch ? {watch:{}} : {})}});
const workerOptions = {
  absWorkingDir: root, entryPoints: ['extension-src/runtime.ts'], outfile: 'extension/runtime.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome125',
  sourcemap: true, legalComments: 'eof',
};
if (watch) { const worker = await context(workerOptions); await worker.watch(); }
else await bundle(workerOptions);
await fs.copyFile(path.join(root,'extension-src/manifest.json'),path.join(destination,'manifest.json'));
await fs.cp(path.join(root,'extension-src/icons'),path.join(destination,'icons'),{recursive:true});
console.log(`Load unpacked: ${destination}`);

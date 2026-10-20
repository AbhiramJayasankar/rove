import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { build as bundle, context } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.resolve(root, 'extension');
if (path.dirname(destination) !== root || path.basename(destination) !== 'extension')
  throw new Error('Refusing to build outside the Rove extension directory.');
const { version } = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const watch = process.argv.includes('--watch');
// This is generated output, bounded to the verified extension directory above.
await fs.mkdir(destination, { recursive: true });
await viteBuild({root, base:'./', define:{__APP_VERSION__:JSON.stringify(version)}, build:{outDir:destination, emptyOutDir:true, ...(watch ? {watch:{}} : {})}});
const workerOptions = {
  absWorkingDir: root, entryPoints: ['extension-src/runtime.ts'], outfile: 'extension/runtime.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome125',
  sourcemap: true, legalComments: 'eof',
};
if (watch) { const worker = await context(workerOptions); await worker.watch(); }
else await bundle(workerOptions);
// package.json is the single source of the version shown in Chrome and in the app.
const manifest = JSON.parse(await fs.readFile(path.join(root,'extension-src/manifest.json'),'utf8'));
manifest.version = version;
await fs.writeFile(path.join(destination,'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.cp(path.join(root,'extension-src/icons'),path.join(destination,'icons'),{recursive:true});
console.log(`Load unpacked: ${destination}`);

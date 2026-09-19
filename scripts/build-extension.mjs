import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'checkto-extension');
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['background', 'panel', 'options'].map(name => path.join(root, 'extension', name + '.js')),
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome118', outdir: output,
  plugins: [{ name: 'extension-adapters', setup(b) {
    b.onResolve({ filter: /\/(browser|env)\.ts$/ }, args => ({ path: path.join(root, 'extension', args.path.endsWith('browser.ts') ? 'browser.js' : 'config.js') }));
  } }],
});
await mkdir(path.join(output, 'fonts'), { recursive: true });
for (const file of ['manifest.json', 'panel.html', 'settings.html', 'style.css', 'fonts/outfit.woff2']) await copyFile(path.join(root, 'extension', file), path.join(output, file));
console.log(`unpacked extension: ${output}`);

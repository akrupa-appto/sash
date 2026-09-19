// Bump the extension's patch version in extension/manifest.json and print the new version.
// `node scripts/bump-extension.mjs minor` bumps the minor part instead.
import { readFile, writeFile } from 'node:fs/promises';
const file = new URL('../extension/manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
const part = process.argv[2] === 'minor' ? 1 : process.argv[2] === 'major' ? 0 : 2;
const parts = manifest.version.split('.').map(Number);
while (parts.length < 3) parts.push(0);
parts[part]++;
for (let i = part + 1; i < 3; i++) parts[i] = 0;
manifest.version = parts.join('.');
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.version);

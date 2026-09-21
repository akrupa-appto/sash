import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const images = path.resolve('docs/images');

function pngSize(buf) {
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function assertPng(name, width, height) {
  const size = pngSize(await readFile(path.join(images, name)));
  assert.deepEqual(size, { width, height }, name);
}

test('README screenshots are display-sized, not 2× captures', async () => {
  await assertPng('panel-intro.png', 400, 720);
  await assertPng('panel-done.png', 400, 720);
  await assertPng('together-working.png', 1280, 720);
  await assertPng('together-done.png', 1280, 720);
  await assertPng('settings-connections.png', 640, 640);
});

test('README pins an HTML width on every screenshot so GitHub does not use intrinsic pixels', async () => {
  const readme = await readFile('README.md', 'utf8');
  assert.doesNotMatch(readme, /!\[[^\]]*\]\(docs\/images\/[^)]+\.png\)/);
  for (const name of ['together-done.png', 'together-working.png', 'panel-intro.png', 'panel-done.png', 'settings-connections.png']) {
    const tag = readme.match(new RegExp(`<img[^>]+src="docs/images/${name}"[^>]*>`));
    assert.ok(tag, name);
    assert.match(tag[0], /width="\d+"/);
  }
  assert.match(readme, /<video\s[^>]*src="docs\/images\/panel-run\.mp4"[^>]*>/);
  assert.match(readme, /<video\s[^>]*width="\d+"[^>]*>/);
});

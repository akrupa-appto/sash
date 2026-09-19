import fs from 'node:fs';
import path from 'node:path';

const directory = process.env.RECORDINGS_DIR || new URL('./data/recordings/', import.meta.url).pathname;
export type Recording = { id: string; anchorId: string; createdAt: string; title: string; state: 'recording' | 'paused' | 'ended' };
const filename = (id: string) => {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('invalid recording ID');
  return path.join(directory, id + '.json');
};
export function readRecording(id: string): Recording | undefined {
  try { return JSON.parse(fs.readFileSync(filename(id), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
}
export function saveRecording(record: Recording) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = filename(record.id);
  fs.writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export async function anchorRecording(anchorId: string, action = '') {
  const response = await fetch(`https://api.anchorbrowser.io/v1/sessions/${encodeURIComponent(anchorId)}/recordings${action ? '/' + action : ''}`, {
    method: action ? 'POST' : 'GET',
    headers: { 'anchor-api-key': process.env.ANCHOR_API_KEY || process.env.ANCHORBROWSER_API_KEY || '' },
    signal: AbortSignal.timeout(15000),
  });
  if (!action && response.status === 404) return [];
  if (!response.ok) throw new Error(`Anchor recording request failed (${response.status}); try again`);
  const body = await response.json();
  return body.data?.items || [];
}

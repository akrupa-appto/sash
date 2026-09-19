import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const pending: any[] = [];
let handler: any;
let activeSignal: AbortSignal | undefined;
let closedWhileUnaborted = false;
let delayClose = false;
const closing: (() => void)[] = [];
mock.method(http, 'createServer', (fn: any) => { handler = fn; return { listen() {} } as any; });
mock.module('../browser.ts', { namedExports: { launch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } });
mock.module('../jev.ts', { namedExports: { jevVia: () => 'test' } });
mock.module('../planner.ts', { namedExports: { plannerModel: () => 'test' } });
mock.module('../agent.ts', { namedExports: { runTask: async (_: any, __: any, emit: any, signal: AbortSignal) => {
  activeSignal = signal;
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  emit({ type: 'end', status: 'stopped' });
} } });
process.env.MAX_SESSIONS = '6';
await import('../server.ts');
function browser() {
  return { page: { url: () => 'https://example.org' }, browser: { close: async () => { if (activeSignal && !activeSignal.aborted) closedWhileUnaborted = true; if (delayClose) await new Promise<void>(resolve => closing.push(resolve)); }, isConnected: () => true } };
}
function request(url: string, body?: any) {
  const req: any = new EventEmitter(); req.method = 'POST'; req.url = url;
  const res: any = Object.assign(new EventEmitter(), { code: 0, body: '', writableEnded: false, writeHead(code: number) { this.code = code; }, write(s: string) { this.body += s; }, end(s = '') { this.body += s; this.writableEnded = true; } });
  const done = handler(req, res);
  if (body) { req.emit('data', JSON.stringify(body)); req.emit('end'); }
  return { res, done };
}

test('session reservations bound concurrent launches, release failures, and close aborts work', async () => {
  const requests = Array.from({ length: 10 }, () => request('/api/session'));
  assert.equal(pending.length, 6, 'only six browser launches may start');
  pending[0].reject(new Error('launch failed'));
  pending.slice(1).forEach(p => p.resolve(browser()));
  await Promise.all(requests.map(r => r.done));
  assert.equal(requests.filter(r => r.res.code === 429).length, 4);
  const replacement = request('/api/session');
  assert.equal(pending.length, 7, 'failed launch frees its reservation');
  pending[6].resolve(browser()); await replacement.done;
  const id = JSON.parse(replacement.res.body).id;
  const task = request(`/api/session/${id}/task`, { message: 'test' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(activeSignal);
  const close = request(`/api/session/${id}/close`);
  await close.done;
  assert.equal(activeSignal.aborted, true);
  await task.done;
  assert.equal(closedWhileUnaborted, false);
  assert.match(task.res.body, /"status":"stopped"/);
});


test('concurrent evictions wait for browser shutdown before launching replacements', async () => {
  const fill = request('/api/session');
  pending.at(-1).resolve(browser());
  await fill.done;
  const before = pending.length;
  delayClose = true;
  const requests = Array.from({ length: 10 }, () => request('/api/session'));
  assert.equal(closing.length, 6);
  assert.equal(pending.length, before, 'no replacement launches before shutdown');
  closing.forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length - before, 6);
  pending.slice(before).forEach(p => p.resolve(browser()));
  await Promise.all(requests.map(r => r.done));
  assert.equal(requests.filter(r => r.res.code === 200).length, 6);
  assert.equal(requests.filter(r => r.res.code === 429).length, 4);
  delayClose = false;
});

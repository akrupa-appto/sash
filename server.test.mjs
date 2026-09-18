import { test, mock, after } from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

let closed = 0, lastInput, taskAborted = false;
mock.module('./browser.ts', { namedExports: { launch: async () => ({
  browser: { isConnected: () => true },
  page: { url: () => 'about:blank', title: async () => '' },
  liveViewUrl: 'https://live.example.test/session', close: async () => { closed++; },
}) } });
mock.module('./jev.ts', { namedExports: { jevVia: () => 'fixture' } });
mock.module('./planner.ts', { namedExports: { plannerModel: () => 'default/model' } });
mock.module('./agent.ts', { namedExports: { runTask: async (_page, input, emit, signal) => {
  lastInput = input;
  if (input.goal.includes('wait')) {
    await new Promise(resolve => signal.addEventListener('abort', () => { taskAborted = true; resolve(); }, {once:true}));
  } else emit({type:'end',status:'done',message:'finished',steps:1,totalCostUsd:0});
} } });
const oldPort = process.env.PORT;
process.env.PORT = '0';
const { server } = await import('./server.ts');
if (!server.listening) await once(server, 'listening');
if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, body = {}) => fetch(base+path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('session exposes the live view and preserves each task model', async () => {
  const { id, liveViewUrl } = await (await post('/api/session')).json();
  assert.equal(liveViewUrl,'https://live.example.test/session');
  for (const model of ['deepseek/deepseek-v4.1-flash','z-ai/glm-5.3-flash','moonshotai/kimi-k3','provider/custom-model:free']) {
    const r = await post(`/api/session/${id}/task`,{message:'open https://example.test',supervisor:true,model});
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].supervisor,model);
    assert.equal(lastInput.model,model);
    assert.equal(lastInput.liveView,true);
  }
  const bad = await post(`/api/session/${id}/task`,{message:'open https://example.test',model:'bad model id'});
  assert.equal(bad.status,400);
  await bad.text();
  const fast = await post(`/api/session/${id}/task`,{message:'open https://example.test',supervisor:false});
  const events = (await fast.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].supervisor,undefined);
  assert.equal(lastInput.supervisor,false);
  await (await post(`/api/session/${id}/close`)).text();
  assert.equal(closed,1);
});

test('closing the task response aborts work and releases the busy state', async () => {
  const { id } = await (await post('/api/session')).json();
  const r = await post(`/api/session/${id}/task`,{message:'wait on https://example.test'});
  await r.body.cancel();
  for(let i=0;i<50 && !taskAborted;i++) await delay(10);
  assert.equal(taskAborted,true);
  const session=await (await fetch(`${base}/api/session/${id}`)).json();
  assert.equal(session.busy,false);
  await (await post(`/api/session/${id}/close`)).text();
  assert.equal(closed,2);
});

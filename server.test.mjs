import { test, mock, after } from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const recordings = new Map(); let recordingFailure = false; const recordingCalls = [];
mock.module('./recordings.ts', { namedExports: {
  readRecording: id => recordings.get(id) && {...recordings.get(id)},
  saveRecording: record => recordings.set(record.id, {...record}),
  anchorRecording: async (id, action) => { recordingCalls.push(action); if(recordingFailure) throw new Error('provider unavailable'); return action ? [] : [{file_link:'https://video.example.test/video.mp4', duration:'5'}]; },
} });
let closed = 0, lastInput, taskAborted = false;
mock.module('./browser.ts', { namedExports: { launch: async () => ({
  browser: { isConnected: () => true }, context: {route: async () => {}},
  page: { url: () => 'about:blank', title: async () => '' },
  anchorId: 'anchor-private-id', liveViewUrl: 'https://live.example.test/session', close: async () => { closed++; },
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
process.env.OPENROUTER_API_KEY ??= 'test-key'; // careful-mode tasks need a connected planner provider
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
    const r = await post(`/api/session/${id}/task`,{message:'open https://example.test',supervisor:true,model,reasoning:'high'});
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].supervisor,model);
    assert.equal(lastInput.model,model);
    assert.equal(lastInput.reasoning,'high');
    assert.equal(lastInput.liveView,true);
    assert.equal(lastInput.maxSteps,60);
  }
  const bad = await post(`/api/session/${id}/task`,{message:'open https://example.test',model:'bad model id'});
  assert.equal(bad.status,400);
  await bad.text();
  for (const reasoning of ['bogus', {}]) {
    const invalid = await post(`/api/session/${id}/task`,{message:'open https://example.test',model:'z-ai/glm-5.3-flash',reasoning});
    assert.equal(invalid.status,400); await invalid.text();
  }
  // Model-specific levels are the picker's and the provider's job; a model whose provider is not connected is rejected here.
  const unconnected = await post(`/api/session/${id}/task`,{message:'open https://example.test',model:'gemini:gemini-2.5-flash'});
  assert.equal(unconnected.status,400); assert.match((await unconnected.json()).error, /Gemini is not connected/);
  const fast = await post(`/api/session/${id}/task`,{message:'open https://example.test',supervisor:false,reasoning:'ignored'});
  const events = (await fast.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].supervisor,undefined);
  assert.equal(lastInput.supervisor,false);
  assert.equal(lastInput.reasoning,'auto');
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

 test('recording controls preserve state on provider failure and gallery never exposes Anchor IDs', async () => {
  const {id}=await (await post('/api/session')).json();
  let r=await post(`/api/session/${id}/recording-start`);
  assert.equal(r.status,200); assert.equal((await r.json()).state,'recording');
  await (await post(`/api/session/${id}/recording-start`)).json();
  assert.deepEqual(recordingCalls,['resume']);
  recordingFailure=true;
  r=await post(`/api/session/${id}/recording-stop`); assert.equal(r.status,502); await r.json();
  assert.equal(recordings.get(id).state,'recording');
  recordingFailure=false;
  await (await post(`/api/session/${id}/recording-stop`)).json();
  let gallery=await (await fetch(base+'/api/recordings/'+id)).json();
  assert.equal(gallery.state,'paused'); assert.equal(gallery.anchorId,undefined); assert.deepEqual(gallery.videos,[]);
  await (await post(`/api/session/${id}/close`)).json();
  gallery=await (await fetch(base+'/api/recordings/'+id)).json();
  assert.equal(gallery.state,'ended'); assert.equal(gallery.videos[0].url,'https://video.example.test/video.mp4');
  assert.equal((await post(`/api/session/${id}/recording-start`)).status,404);
  assert.equal((await fetch(base+'/api/recordings/0000000000000000')).status,404);
});

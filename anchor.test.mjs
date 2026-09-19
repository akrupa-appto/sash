import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let failConnection = false, disconnected = 0;
const page = { on() {} };
const context = { pages: () => [page] };
mock.module('playwright', { namedExports: { chromium: {
  connectOverCDP: async () => {
    if (failConnection) throw new Error('could not connect wss://example.test?secret=private');
    return { contexts: () => [context], close: async () => { disconnected++; } };
  },
  launch: async () => { throw new Error('must not launch local Chromium'); },
} } });
const { launch } = await import('./browser.ts');

for (const failure of [false, true]) test(failure ? 'connection failure releases the Anchor session and redacts credentials' : 'Anchor session uses the existing context and closes once', async () => {
  const oldKey = process.env.ANCHOR_API_KEY;
  process.env.ANCHOR_API_KEY = 'test-key';
  failConnection = failure; disconnected = 0;
  const requests = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({url, ...options});
    return new Response(JSON.stringify({data: options.method === 'POST'
      ? {id:'test-session',cdp_url:'wss://example.test',live_view_url:'https://live.example.test'} : {status:'success'}}));
  });
  try {
    if (failure) await assert.rejects(launch(), e => /could not connect to Anchor Browser/.test(e.message) && !e.message.includes('private'));
    else {
      const session = await launch();
      assert.equal(session.page, page);
      assert.equal(session.liveViewUrl, 'https://live.example.test');
      await Promise.all([session.close(),session.close()]);
      assert.equal(disconnected,1);
    }
    assert.deepEqual(requests.map(r => r.method),['POST','POST','DELETE']);
    assert.equal(requests[2].url,'https://api.anchorbrowser.io/v1/sessions/test-session');
    const config=JSON.parse(requests[0].body);
    assert.equal(config.session.timeout.max_duration,60);
    assert.equal(config.session.live_view.read_only,true);
  } finally {
    fetchMock.mock.restore();
    if(oldKey===undefined) delete process.env.ANCHOR_API_KEY; else process.env.ANCHOR_API_KEY=oldKey;
  }
});

test('failed initial pause releases the new session before any page is opened', async () => {
  const oldKey=process.env.ANCHOR_API_KEY;process.env.ANCHOR_API_KEY='test';
  const requests=[];
  const f=mock.method(globalThis,'fetch',async (url,options)=>{
    requests.push({url,...options});
    if(url.endsWith('/recordings/pause'))return new Response('{}',{status:503});
    return new Response(JSON.stringify({data:{id:'pause-failure'}}));
  });
  try{await assert.rejects(launch(),/could not connect/);assert.equal(requests.at(-1).method,'DELETE');assert.equal(requests.at(-1).url,'https://api.anchorbrowser.io/v1/sessions/pause-failure');}
  finally{f.mock.restore();if(oldKey===undefined)delete process.env.ANCHOR_API_KEY;else process.env.ANCHOR_API_KEY=oldKey;}
});

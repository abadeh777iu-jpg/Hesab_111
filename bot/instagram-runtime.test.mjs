import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('real workerd parses source HTML, uploads multipart video and recognizes music only on its inline callback', async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import worker, { ChatSession as Session, MarketFeed as Feed } from './worker.mjs';
    export class ChatSession extends Session { constructor(ctx, env) { super(ctx, { ...env, fetchImpl: (url, options) => env.UPSTREAM.fetch(url, options) }); } }
    export class MarketFeed extends Feed { constructor(ctx, env) { super(ctx, { ...env, fetchImpl: (url, options) => env.UPSTREAM.fetch(url, options) }); } }
    export default worker;
  ` }, bundle: true, external: ['cloudflare:workers'], write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'instagram-runtime', modules: true, compatibilityDate: '2026-10-01', script: bundle.outputFiles[0].text,
    durableObjects: { CHATS: 'ChatSession', MARKETS: 'MarketFeed' }, serviceBindings: { UPSTREAM: 'fake-instagram-source' },
    bindings: { BOT_ASYNC_UPDATES: 'false', TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_WEBHOOK_SECRET: 'fake-secret', TELEGRAM_ALLOWED_USER_IDS: '42,43', OPENROUTER_API_KEY: 'unused-secret', OPENROUTER_MODEL: 'unused-model' },
  }, {
    name: 'fake-instagram-source', modules: true, compatibilityDate: '2026-10-01', script: `
      let musicCalls = 0, videoCalls = 0, uploadCalls = 0, reuseCalls = 0, cdnCalls = 0, token = null; const sent = [];
      export default { async fetch(request) {
        const u = new URL(request.url);
        if (u.hostname === 'control.test') return Response.json({ musicCalls, videoCalls, uploadCalls, reuseCalls, cdnCalls, token, sent });
        if (u.hostname === 'openrouter.ai') throw new Error('Must not charge a model');
        if (u.hostname === 'www.vxinstagram.com') {
          if (u.search || request.headers.has('Authorization') || u.pathname !== '/reel/DfUr8XJoNJC/') throw new Error('Private data leaked');
          videoCalls++; return new Response('<video><source src="https://instagram.example.fna.fbcdn.net/video.mp4?sig=public"></video>', { headers: { 'Content-Type': 'text/html' } });
        }
        if (u.hostname === 'instagram.example.fna.fbcdn.net') { cdnCalls++; return new Response(new Uint8Array([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]), { headers: { 'Content-Type': 'video/mp4' } }); }
        if (u.hostname === 'songfinder.dev') {
          const form = await request.formData();
          if (form.get('url') !== 'https://www.instagram.com/reel/DfUr8XJoNJC/' || form.get('source') !== 'cli' || request.headers.get('X-SongFinder-Client') !== 'cli' || request.headers.has('Authorization')) throw new Error('Bad recognition contract');
          musicCalls++; return Response.json({ code: 0, data: { matched: true, title: 'Runtime song', artist: 'Runtime artist', songLink: 'https://www.shazam.com/track/123/runtime-song' } });
        }
        if (u.hostname !== 'api.telegram.org') throw new Error('Unexpected URL');
        const method = u.pathname.split('/').at(-1);
        if (method === 'sendVideo') {
          const form = await request.formData(); const video = form.get('video');
          if (video === 'runtime-video') reuseCalls++;
          else if (!(video instanceof Blob) || video.size !== 16 || form.get('caption').includes('private-tracking')) throw new Error('Bad file upload');
          token = JSON.parse(form.get('reply_markup')).inline_keyboard[0][0].callback_data; uploadCalls++;
          return Response.json({ ok: true, result: { message_id: 777, video: { file_id: 'runtime-video' } } });
        }
        const body = await request.json(); let result = true;
        if (method === 'getMe') result = { id: 900, is_bot: true };
        if (method === 'getChatMember') result = { user: { id: body.user_id }, status: body.user_id === 900 ? 'administrator' : 'member' };
        if (method === 'getWebhookInfo') result = { url: 'https://runtime.test/webhook', allowed_updates: ['message', 'callback_query'] };
        if (method === 'sendMessage') sent.push(body.text);
        return Response.json({ ok: true, result });
      } };
    `,
  }] }));
  t.after(() => mf.dispose());
  const fake = await mf.getWorker('fake-instagram-source');
  const stats = async () => (await fake.fetch('https://control.test/')).json();
  const dispatch = async body => {
    assert.equal((await mf.dispatchFetch('https://runtime.test/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fake-secret' }, body: JSON.stringify(body) })).status, 200);
  };
  await dispatch({ update_id: 1, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'https://www.instagram.com/reel/DfUr8XJoNJC/?exln=private-tracking' } });
  let data = await stats(); assert.equal(data.uploadCalls, 1); assert.equal(data.musicCalls, 0); assert.equal(data.videoCalls, 1);
  assert.match(data.token, /^igmusic:[a-f0-9]{32}$/);
  const callback = { update_id: 2, callback_query: { id: 'music-runtime', data: data.token, from: { id: 42 }, message: { message_id: 777, chat: { id: 42, type: 'private' } } } };
  await dispatch(callback); data = await stats(); assert.equal(data.musicCalls, 1);
  assert.ok(data.sent.at(-1).includes('Runtime song')); assert.ok(data.sent.at(-1).includes('https://www.shazam.com/track/123/runtime-song'));
  await dispatch(callback); assert.equal((await stats()).musicCalls, 1);
  await dispatch({ update_id: 3, message: { from: { id: 43 }, chat: { id: 43, type: 'private' }, text: 'https://www.instagram.com/reel/DfUr8XJoNJC/' } });
  data = await stats(); assert.equal(data.uploadCalls, 2); assert.equal(data.reuseCalls, 1);
  assert.equal(data.cdnCalls, 1); assert.equal(data.videoCalls, 1); assert.equal(data.musicCalls, 1);
});

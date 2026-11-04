import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Production default, real Durable Object storage/alarms/RPC in workerd.
// No paid provider/network access: all upstream calls terminate in a local fake.
test('workerd durable alarm drains the default inbox while concurrent ingress and callback acknowledgments remain responsive', { timeout: 15000 }, async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import worker, { ChatSession as Session, MarketFeed } from './worker.mjs';
    export { MarketFeed };
    export class ChatSession extends Session {
      constructor(ctx, env) { super(ctx, { ...env, fetchImpl: (url, options) => env.UPSTREAM.fetch(url, options) }); this.testStorage = ctx.storage; }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/test-prime') {
          await this.testStorage.put('followup', { disabled: true, noticeShown: true });
          await this.testStorage.put('weatherOptOut', true);
          return new Response('primed');
        }
        if (path === '/test-inspect') return Response.json({ inbox: await this.testStorage.get('inbox'), session: await this.testStorage.get('session'), alarm: await this.testStorage.getAlarm() });
        if (path === '/test-finish-current') { await this.handler.queue; return new Response('finished'); }
        if (path === '/test-drain') {
          await this.handler.queue;
          const inbox = await this.testStorage.get('inbox'); inbox.nextAt = Date.now() - 1; await this.testStorage.put('inbox', inbox);
          const record = await this.testStorage.get('session'); if (record) { record.lastAt = 0; await this.testStorage.put('session', record); }
          await this.handler.alarm(); return new Response('drained');
        }
        return super.fetch(request);
      }
    }
    export default worker;
  ` }, bundle: true, external: ['cloudflare:workers'], write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'load-runtime', modules: true, compatibilityDate: '2026-10-01', script: bundle.outputFiles[0].text,
    durableObjects: { CHATS: 'ChatSession', MARKETS: 'MarketFeed' }, serviceBindings: { UPSTREAM: 'fake-load-source' },
    bindings: { JOIN_REQUIRED: 'false', TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_WEBHOOK_SECRET: 'fake-secret', TELEGRAM_ALLOWED_USER_IDS: '42', OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'fake-model' },
  }, {
    name: 'fake-load-source', modules: true, compatibilityDate: '2026-10-01', script: `
      let modelCalls = 0, callbacks = 0, started, release; const sent = [];
      const modelStarted = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      export default { async fetch(request) {
        const u = new URL(request.url);
        if (u.hostname === 'control.test') {
          if (u.pathname === '/wait-model') await Promise.race([modelStarted, new Promise(resolve => setTimeout(resolve, 5000))]);
          if (u.pathname === '/release') release();
          return Response.json({ modelCalls, callbacks, sent });
        }
        const body = await request.json();
        if (u.hostname === 'openrouter.ai') {
          modelCalls++; started(); await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 6000))]);
          return Response.json({ choices: [{ message: { content: 'پاسخ آزمایشی' } }] });
        }
        if (u.hostname !== 'api.telegram.org') throw new Error('Unexpected upstream');
        const method = u.pathname.split('/').at(-1);
        if (method === 'sendMessage') sent.push(body.text);
        if (method === 'answerCallbackQuery') callbacks++;
        return Response.json({ ok: true, result: true });
      } };
    `,
  }] }));
  const upstream = await mf.getWorker('fake-load-source');
  t.after(async () => { await upstream.fetch('https://control.test/release'); await mf.dispose(); });
  const chats = await mf.getDurableObjectNamespace('CHATS', 'load-runtime');
  const chat = chats.get(chats.idFromName('42'));
  const control = async path => (await upstream.fetch('https://control.test' + path, { signal: AbortSignal.timeout(5000) })).json();
  const inspect = async () => (await chat.fetch('https://test/test-inspect')).json();
  const dispatch = async body => {
    const response = await mf.dispatchFetch('https://runtime.test/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fake-secret' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
  };
  const message = text => ({ from: { id: 42 }, chat: { id: 42, type: 'private' }, text });
  await chat.fetch('https://test/test-prime');
  await dispatch({ update_id: 1, message: message('پیام اول') });
  await control('/wait-model'); // Real scheduled alarm, not an explicit drain call.
  assert.equal((await inspect()).inbox.active.id, 'u1');
  await dispatch({ update_id: 2, message: message('پیام دوم') });
  await dispatch({ update_id: 2, message: message('پیام دوم') });
  await dispatch({ update_id: 3, callback_query: { id: 'callback', data: 'membership:check:v1', from: { id: 42 }, message: { message_id: 77, chat: { id: 42, type: 'private' } } } });
  const blocked = await inspect(); assert.equal(blocked.inbox.pending.length, 2); assert.ok(blocked.alarm > Date.now());
  let data = await control('/'); assert.equal(data.modelCalls, 1); assert.equal(data.callbacks, 1); assert.equal(data.sent.length, 1); // greeting only; model still blocked
  await control('/release'); await chat.fetch('https://test/test-finish-current');
  assert.equal((await inspect()).session.messages.length, 2);
  await chat.fetch('https://test/test-drain');
  await chat.fetch('https://test/test-drain');
  data = await control('/'); assert.equal(data.modelCalls, 2); assert.equal(data.callbacks, 1);
  assert.equal((await inspect()).inbox.pending.length, 0);
  assert.equal((await inspect()).session.messages.length, 4);
});

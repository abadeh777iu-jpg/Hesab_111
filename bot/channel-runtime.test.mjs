import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('workerd indexes a new source-channel post and forwards it only after a membership-verified, message-bound callback', { timeout: 15000 }, async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import worker, { ChatSession as Session, MarketFeed } from './worker.mjs';
    export { MarketFeed };
    export class ChatSession extends Session {
      constructor(ctx, env) { super(ctx, { ...env, fetchImpl: (url, options) => env.UPSTREAM.fetch(url, options) }); this.testStorage = ctx.storage; }
      async fetch(request) {
        if (new URL(request.url).pathname === '/test-drain') {
          await this.handler.queue;
          const inbox = await this.testStorage.get('inbox');
          if (inbox?.pending.length) { inbox.nextAt = Date.now() - 1; await this.testStorage.put('inbox', inbox); }
          await this.handler.alarm(); return new Response('drained');
        }
        return super.fetch(request);
      }
    }
    export default worker;
  ` }, bundle: true, external: ['cloudflare:workers'], write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'channel-runtime', modules: true, compatibilityDate: '2026-10-01', script: bundle.outputFiles[0].text,
    durableObjects: { CHATS: 'ChatSession', MARKETS: 'MarketFeed' }, serviceBindings: { UPSTREAM: 'fake-channel-telegram' },
    bindings: { CHANNEL_CONFIRMATION_REQUIRED: 'true', TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_WEBHOOK_SECRET: 'fake-secret', TELEGRAM_ALLOWED_USER_IDS: '42', OPENROUTER_API_KEY: 'unused-key', OPENROUTER_MODEL: 'unused-model' },
  }, {
    name: 'fake-channel-telegram', modules: true, compatibilityDate: '2026-10-01', script: `
      let nextId = 100, memberships = 0; const sent = [], forwards = [], methods = [];
      export default { async fetch(request) {
        const u = new URL(request.url);
        if (u.hostname === 'control.test') return Response.json({ sent, forwards, methods, memberships });
        if (u.hostname !== 'api.telegram.org') throw new Error('Channel library must not call paid or media providers');
        const body = await request.json(), method = u.pathname.split('/').at(-1); methods.push(method); let result = true;
        if (method === 'getMe') result = { id: 900, is_bot: true };
        if (method === 'getChatMember') {
          if (body.chat_id !== '@qhatel_roya') throw new Error('Wrong channel');
          memberships++; result = { user: { id: body.user_id }, status: body.user_id === 900 ? 'administrator' : 'member' };
        }
        if (method === 'getChat') result = { id: -1001234567890, username: 'qhatel_roya', type: 'channel', has_protected_content: false };
        if (method === 'getWebhookInfo') result = { url: 'https://runtime.test/webhook', max_connections: 4, allowed_updates: ['message', 'callback_query', 'channel_post', 'edited_channel_post'] };
        if (method === 'sendMessage') { result = { message_id: ++nextId }; sent.push({ ...body, message_id: result.message_id }); }
        if (method === 'forwardMessage') { forwards.push(body); result = { message_id: ++nextId }; }
        return Response.json({ ok: true, result });
      } };
    `,
  }] }));
  t.after(() => mf.dispose());
  const upstream = await mf.getWorker('fake-channel-telegram');
  const stats = async () => (await upstream.fetch('https://control.test/')).json();
  const chats = await mf.getDurableObjectNamespace('CHATS', 'channel-runtime'); const chat = chats.get(chats.idFromName('42'));
  const dispatch = async body => {
    const response = await mf.dispatchFetch('https://runtime.test/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fake-secret' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  };
  await dispatch({ update_id: 1, channel_post: { message_id: 55, date: Math.floor(Date.now() / 1000), chat: { id: -1001234567890, type: 'channel', username: 'qhatel_roya' }, audio: { file_id: 'not-downloaded', title: 'آهنگ شاد' }, caption: '#شاد' } });
  assert.equal((await stats()).methods.length, 0);
  await dispatch({ update_id: 2, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/song شاد' } });
  await chat.fetch('https://test/test-drain');
  let data = await stats(); const offer = data.sent.find(s => s.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('chpick:'));
  assert.ok(offer); assert.equal(data.forwards.length, 0); assert.match(offer.reply_markup.inline_keyboard[1][0].url, /^https:\/\/t.me\/qhatel_roya\/55$/);
  const callback = { update_id: 3, callback_query: { id: 'channel-choice', data: offer.reply_markup.inline_keyboard[0][0].callback_data, from: { id: 42 }, message: { message_id: offer.message_id, chat: { id: 42, type: 'private' } } } };
  await dispatch(callback); await chat.fetch('https://test/test-drain');
  data = await stats(); assert.deepEqual(data.forwards, [{ chat_id: 42, from_chat_id: -1001234567890, message_id: 55 }]);
  assert.ok(data.memberships >= 4);
  assert.ok(!data.methods.some(method => ['sendAudio', 'sendVideo', 'copyMessage', 'getFile'].includes(method)));
  await dispatch(callback); await chat.fetch('https://test/test-drain');
  assert.equal((await stats()).forwards.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Actual webhook + Durable Object in workerd; every provider is a local fake.
test('workerd enforces join, upgrades message-only webhook, handles inline callback and then allows chat', async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import worker, { ChatSession as ProductionSession } from './worker.mjs';
    export class ChatSession extends ProductionSession {
      constructor(ctx, env) { super(ctx, { ...env, fetchImpl: (url, options) => env.UPSTREAM.fetch(url, options) }); }
    }
    export default worker;
  ` }, bundle: true, external: ['cloudflare:workers'], write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'join-runtime', modules: true, compatibilityDate: '2026-10-01', script: bundle.outputFiles[0].text,
    durableObjects: { CHATS: 'ChatSession' }, serviceBindings: { UPSTREAM: 'fake-join-telegram' },
    bindings: { BOT_ASYNC_UPDATES: 'false', TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_WEBHOOK_SECRET: 'fake-secret', TELEGRAM_ALLOWED_USER_IDS: '42', OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'test-model' },
  }, {
    name: 'fake-join-telegram', modules: true, compatibilityDate: '2026-10-01', script: `
      let status = 'left', modelCalls = 0, callbacks = 0, updates = ['message']; const sent = [];
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (url.hostname === 'control.test') {
          if (url.pathname === '/join') status = 'member';
          return Response.json({ modelCalls, callbacks, updates, sent });
        }
        const body = await request.json(); let result = true;
        if (url.hostname === 'openrouter.ai') { modelCalls++; return Response.json({ choices: [{ message: { content: 'دوست داری بیشتر بگی؟' } }] }); }
        if (url.hostname !== 'api.telegram.org') throw new Error('Unexpected upstream');
        const method = url.pathname.split('/').at(-1);
        if (method === 'getMe') result = { id: 900, is_bot: true };
        if (method === 'getChatMember') {
          if (body.chat_id !== '@qhatel_roya') throw new Error('Wrong channel');
          result = { user: { id: body.user_id }, status: body.user_id === 900 ? 'administrator' : status };
        }
        if (method === 'getWebhookInfo') result = { url: 'https://runtime.test/webhook', allowed_updates: updates, max_connections: 1 };
        if (method === 'setWebhook') {
          if (body.secret_token !== 'fake-secret' || body.drop_pending_updates !== false || body.url !== 'https://runtime.test/webhook') throw new Error('Unsafe webhook update');
          updates = body.allowed_updates;
        }
        if (method === 'sendMessage') sent.push(body);
        if (method === 'answerCallbackQuery') callbacks++;
        return Response.json({ ok: true, result });
      } };
    `,
  }] }));
  t.after(() => mf.dispose());
  const fake = await mf.getWorker('fake-join-telegram');
  const stats = async (path = '/') => (await fake.fetch('https://control.test' + path)).json();
  const dispatch = async body => {
    const response = await mf.dispatchFetch('https://runtime.test/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fake-secret' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
  };
  const message = text => ({ chat: { id: 42, type: 'private' }, from: { id: 42 }, text });
  await dispatch({ update_id: 1, message: message('/stop') });
  await dispatch({ update_id: 2, message: message('سلام') });
  let data = await stats();
  assert.equal(data.modelCalls, 0);
  assert.ok(data.updates.includes('callback_query'));
  assert.equal(data.sent.at(-1).reply_markup.inline_keyboard[0][0].url, 'https://t.me/qhatel_roya');
  await stats('/join');
  await dispatch({ update_id: 3, callback_query: { id: 'test-callback', from: { id: 42 }, data: 'membership:check:v1', message: { message_id: 10, chat: { id: 42, type: 'private' } } } });
  data = await stats(); assert.equal(data.callbacks, 1); assert.equal(data.modelCalls, 0);
  assert.ok(data.sent.at(-1).text.includes('عضویتت تأیید شد'));
  await dispatch({ update_id: 4, message: message('سلام') });
  data = await stats(); assert.equal(data.modelCalls, 1);
  assert.ok(data.sent.at(-1).text.includes('دوست داری بیشتر بگی'));
});

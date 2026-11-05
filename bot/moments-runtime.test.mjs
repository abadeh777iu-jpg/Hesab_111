import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('workerd composes cloud facts, one AI sentence and a bounded native post; direct channel requests need no new consent', { timeout: 15000 }, async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import worker, { ChatSession as Session, MarketFeed } from './worker.mjs';
    export { MarketFeed };
    export class ChatSession extends Session {
      constructor(ctx, env) { super(ctx, { ...env, fetchImpl: (url, options) => env.UPSTREAM.fetch(url, options) }); this.storage = ctx.storage; }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/test-weather') {
          const record = await this.storage.get('weather') || { city: { name: 'آباده', latitude: 31.16, longitude: 52.65 }, chatId: 42, alertsEnabled: true };
          record.nextCheckAt = Date.now() - 1; await this.storage.put('weather', record);
          await this.storage.put('followup', { disabled: false, noticeShown: true });
          await this.handler.alarm(); return new Response('weather checked');
        }
        if (path === '/test-drain') {
          await this.handler.queue;
          const inbox = await this.storage.get('inbox');
          if (inbox?.pending.length) { inbox.nextAt = Date.now() - 1; await this.storage.put('inbox', inbox); }
          await this.handler.alarm(); return new Response('drained');
        }
        return super.fetch(request);
      }
    }
    export default worker;
  ` }, bundle: true, external: ['cloudflare:workers'], write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'moments-runtime', modules: true, compatibilityDate: '2026-10-01', script: bundle.outputFiles[0].text,
    durableObjects: { CHATS: 'ChatSession', MARKETS: 'MarketFeed' }, serviceBindings: { UPSTREAM: 'fake-moments-upstream' },
    bindings: { TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_WEBHOOK_SECRET: 'fake-secret', TELEGRAM_ALLOWED_USER_IDS: '42,43', OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'fake-model' },
  }, {
    name: 'fake-moments-upstream', modules: true, compatibilityDate: '2026-10-01', script: `
      const sent = [], forwards = []; let models = 0;
      export default { async fetch(request) {
        const u = new URL(request.url);
        if (u.hostname === 'control.test') return Response.json({ sent, forwards, models });
        if (u.hostname === 'api.open-meteo.com') {
          if (!u.searchParams.get('current').includes('cloud_cover')) throw new Error('Missing cloud-cover data');
          const hour = Math.floor(Date.now() / 3600000) * 3600;
          return Response.json({ timezone: 'Asia/Tehran', current: { time: Math.floor(Date.now() / 1000), temperature_2m: 12, weather_code: 3, cloud_cover: 95 }, hourly: { time: [hour, hour + 3600, hour + 7200], weather_code: [3, 3, 3], cloud_cover: [95, 95, 95], precipitation_probability: [0, 0, 0], rain: [0, 0, 0], snowfall: [0, 0, 0] } });
        }
        const body = await request.json();
        if (u.hostname === 'openrouter.ai') {
          models++; if (body.max_tokens !== 120 || JSON.parse(body.messages[1].content).weather !== 'cloud') throw new Error('Unexpected generation');
          return Response.json({ choices: [{ message: { content: 'اگه ابرها رو دوست داری، یه مکث آروم کنار پنجره به خودت هدیه بده ☁️' } }] });
        }
        if (u.hostname !== 'api.telegram.org') throw new Error('Unexpected provider');
        const method = u.pathname.split('/').at(-1); let result = true;
        if (method === 'getMe') result = { id: 900, is_bot: true };
        if (method === 'getChatMember') result = { user: { id: body.user_id }, status: body.user_id === 900 ? 'administrator' : 'member' };
        if (method === 'getChat') result = { id: -1001234567890, type: 'channel', username: 'qhatel_roya' };
        if (method === 'getWebhookInfo') result = { url: 'https://runtime.test/webhook', max_connections: 4, allowed_updates: ['message', 'callback_query', 'channel_post', 'edited_channel_post'] };
        if (method === 'sendMessage') { sent.push(body); result = { message_id: 100 + sent.length }; }
        if (method === 'forwardMessage') { forwards.push(body); result = { message_id: 200 + forwards.length }; }
        return Response.json({ ok: true, result });
      } };
    `,
  }] }));
  t.after(() => mf.dispose());
  const upstream = await mf.getWorker('fake-moments-upstream'); const stats = async () => (await upstream.fetch('https://control.test/')).json();
  const chats = await mf.getDurableObjectNamespace('CHATS', 'moments-runtime');
  const dispatch = async body => { assert.equal((await mf.dispatchFetch('https://runtime.test/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fake-secret' }, body: JSON.stringify(body) })).status, 200); };
  await dispatch({ update_id: 1, channel_post: { message_id: 55, date: Math.floor(Date.now() / 1000), chat: { id: -1001234567890, type: 'channel', username: 'qhatel_roya' }, audio: { file_id: 'never-downloaded', title: 'آهنگ آرام' }, caption: '#ابری #آرام' } });
  const first = chats.get(chats.idFromName('42')); await first.fetch('https://test/test-weather');
  let data = await stats(); assert.equal(data.models, 1); assert.equal(data.forwards.length, 1);
  assert.ok(data.sent[0].text.includes('آسمون ابریه')); assert.ok(data.sent[0].text.includes('هدیه بده')); assert.ok(data.sent[0].text.includes('Open-Meteo'));
  assert.equal(data.forwards[0].chat_id, 42);
  await first.fetch('https://test/test-weather'); data = await stats(); assert.equal(data.models, 1); assert.equal(data.forwards.length, 1);
  await dispatch({ update_id: 2, message: { from: { id: 43 }, chat: { id: 43, type: 'private' }, text: '/song ابری' } });
  await chats.get(chats.idFromName('43')).fetch('https://test/test-drain');
  data = await stats(); assert.equal(data.forwards.length, 2); assert.equal(data.forwards[1].chat_id, 43); assert.equal(data.models, 1);
  assert.ok(!data.sent.some(row => row.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('chpick:')));
});

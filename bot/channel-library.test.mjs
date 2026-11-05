import test from 'node:test';
import assert from 'node:assert/strict';
import { compactChannelPost, channelRequest, ChannelLibraryHandler, LIBRARY_TTL, LIBRARY_LIMIT, selectChannelPost, positiveWeatherContext, selectChannelMoment } from './channel-library.mjs';
import { ChatSession, createWorker } from './cloudflare.mjs';
import { CapacityHandler } from './load-control.mjs';

const CHANNEL = -1001234567890;
function memory() {
  const state = new Map(); let alarm;
  return { state, get alarm() { return alarm; }, storage: { get: async k => structuredClone(state.get(k)), put: async (k, v) => state.set(k, structuredClone(v)), delete: async k => state.delete(k), setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = undefined; } } };
}
const post = (id = 1, extra = {}) => ({ update_id: id, channel_post: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: CHANNEL, type: 'channel', username: 'qhatel_roya' }, audio: { file_id: 'must-not-store', title: 'آهنگ شاد', performer: 'خواننده' }, caption: '#شاد #انرژی', ...extra } });
const rpc = (handler, path, body) => handler.fetch(new Request('https://internal/channel-' + path, { method: 'POST', body: JSON.stringify(body) }));

test('only authenticated source-channel shapes can become catalogue data; binaries, profiles and protected text are excluded', () => {
  const raw = post(); raw.channel_post.from = { id: 99, first_name: 'private-name' };
  const value = compactChannelPost(raw); assert.equal(value.kind, 'song'); assert.ok(!JSON.stringify(value).includes('must-not-store')); assert.ok(!JSON.stringify(value).includes('private-name'));
  for (const chat of [{ id: CHANNEL, type: 'channel', username: 'other' }, { id: CHANNEL, type: 'supergroup', username: 'qhatel_roya' }, { id: 42, type: 'channel', username: 'qhatel_roya' }]) assert.equal(compactChannelPost(post(2, { chat })), null);
  const protectedPost = compactChannelPost(post(2, { has_protected_content: true, caption: 'protected-secret' }));
  assert.equal(protectedPost.kind, null); assert.equal(protectedPost.text, ''); assert.equal(protectedPost.title, '');
  assert.equal(compactChannelPost({ ...post(), message: { text: 'private' } }), null);
  assert.equal(compactChannelPost(post(3, { audio: undefined, video: { file_id: 'video' } })).kind, 'video');
  assert.equal(compactChannelPost(post(4, { audio: undefined, text: 'یک جمله' })).kind, 'quote');
});

test('channel requests are explicit; normal distress, generation and song-identification requests stay in their own paths', () => {
  assert.equal(channelRequest('یه آهنگ شاد بفرست').kind, 'song');
  assert.equal(channelRequest('یک کلیپ داری؟').kind, 'video');
  assert.equal(channelRequest('یه جمله قشنگ بگو').kind, 'quote');
  assert.deepEqual(channelRequest('/song@my_bot آرام'), { kind: 'song', query: 'آرام' });
  assert.equal(channelRequest('/channel').kind, null);
  for (const text of ['دلم گرفته', 'میخوام درباره آهنگ حرف بزنیم', 'میخوام فیلمسازی یاد بگیرم', 'یه جمله‌بندی خوب بهم پیشنهاد بده', 'میخوام برم فیلم ببینم', 'درباره فیلم بهم بگو', 'آهنگ نفرست', 'آهنگ نمی‌خوام', 'اسم آهنگ این ریلز چیه؟', 'یه آهنگ بساز', 'میخوام خودکشی کنم یه آهنگ بده', '/song میخوام خودکشی کنم', 'میخوام خودمو بکشم یه آهنگ بده', '/song kill myself', '/song نمی‌خوام', '/voice آهنگ بده']) assert.equal(channelRequest(text), null, text);
});

test('catalogue is capped at 200 public excerpts, deduplicates retries, handles out-of-order edits and keeps protected tombstones', async () => {
  const m = memory(), handler = new ChannelLibraryHandler(m);
  for (let i = 1; i <= 220; i++) await rpc(handler, 'update', compactChannelPost(post(i)));
  assert.equal(m.state.get('channelPosts').length, LIBRARY_LIMIT);
  const original = compactChannelPost(post(220)); await rpc(handler, 'update', original);
  await rpc(handler, 'update', { ...original, version: 999, kind: null, text: 'must-not-persist' });
  await rpc(handler, 'update', original);
  assert.equal((await (await rpc(handler, 'get', { channelId: CHANNEL, id: 220 })).json()).value, null);
  assert.ok(!JSON.stringify(m.state.get('channelPosts')).includes('must-not-persist'));
  assert.ok(Number.isFinite(m.alarm));
});

test('edit timestamps handle Telegram update-id reseeding after inactivity without accepting an older replay', async () => {
  const m = memory(), handler = new ChannelLibraryHandler(m), original = compactChannelPost(post(1));
  await rpc(handler, 'update', { ...original, version: 9000 });
  await rpc(handler, 'update', { ...original, version: 2, revisionAt: original.date + 604800, text: 'updated' });
  await rpc(handler, 'update', { ...original, version: 9999 });
  assert.equal(m.state.get('channelPosts')[0].text, 'updated');
});

test('local selection uses text/caption tags, never pretends to hear media and does not fabricate a missing match', () => {
  const rows = [{ id: 1, kind: 'song', date: 1, text: 'آهنگ غمگین', expiresAt: Date.now() + 10000 }, { id: 2, kind: 'song', date: 2, text: 'شاد انرژی', expiresAt: Date.now() + 10000 }];
  assert.equal(selectChannelPost(rows, 'song', 'شاد').id, 2);
  assert.equal(selectChannelPost(rows, 'song', 'آروم'), null);
  assert.equal(selectChannelPost(rows, 'song', 'نام ناموجود'), null);
  assert.equal(selectChannelPost(rows, null, ''), null);
  assert.equal(selectChannelPost(rows, 'song', '', [2]).id, 1);
});

test('public excerpts expire and an alarm physically clears the bounded catalogue', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const m = memory(), handler = new ChannelLibraryHandler(m);
  await rpc(handler, 'update', compactChannelPost(post())); now += LIBRARY_TTL + 1;
  await handler.alarm(); assert.equal(m.state.has('channelPosts'), false); assert.equal(m.alarm, undefined);
});

function fixture(t) {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const library = memory(), catalogue = new ChannelLibraryHandler(library), capacityStore = memory(), capacity = new CapacityHandler(capacityStore);
  const sessions = new Map(), stores = new Map(), calls = []; let messageId = 100;
  const f = { library, catalogue, capacity, capacityStore, calls, sessions, stores, member: 'member', protected: false, forwardFails: false, advance: ms => { now += ms; } };
  const env = { TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_WEBHOOK_SECRET: 'fake-secret', TELEGRAM_ALLOWED_USER_IDS: '*', OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: 'fake-model', JOIN_REQUIRED: 'false', CHANNEL_CONFIRMATION_REQUIRED: 'true',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (url.includes('openrouter.ai')) return Response.json({ choices: [{ message: { content: 'می‌شنوم، بیشتر بگو 🌱' } }] });
      const method = url.split('/').at(-1); let result = true;
      if (method === 'getChat') result = { id: CHANNEL, type: 'channel', username: 'qhatel_roya', has_protected_content: f.protected };
      if (method === 'getMe') result = { id: 900, is_bot: true };
      if (method === 'getChatMember') result = { user: { id: body.user_id }, status: body.user_id === 900 ? 'administrator' : f.member };
      if (method === 'getWebhookInfo') result = { url: 'https://bot.test/webhook', max_connections: 4, allowed_updates: ['message', 'callback_query', 'channel_post', 'edited_channel_post'] };
      if (method === 'sendMessage' || method === 'forwardMessage') result = { message_id: ++messageId };
      if (method === 'forwardMessage' && f.forwardFails) throw new Error('private-failure');
      return Response.json({ ok: true, result });
    },
  };
  env.MARKETS = { idFromName: name => name, get: name => ({ fetch: (url, options) => (name === 'channel-library' ? catalogue : capacity).fetch(new Request(url, options)) }) };
  env.CHATS = { idFromName: name => name, get: name => ({ fetch: (url, options) => {
    if (!sessions.has(name)) { const store = memory(); store.state.set('followup', { disabled: true }); store.state.set('weatherOptOut', true); stores.set(name, store); sessions.set(name, new ChatSession(store, env)); }
    return sessions.get(name).fetch(new Request(url, options));
  } }) };
  f.env = env;
  f.dispatch = async (update, secret = 'fake-secret') => {
    const response = await createWorker().fetch(new Request('https://bot.test/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(update) }), env);
    const id = update.message?.from?.id || update.callback_query?.from?.id;
    if (response.ok && id && sessions.has(String(id))) { now += 200; await sessions.get(String(id)).alarm(); }
    return response;
  };
  f.ask = async (id = 1000, text = '/song شاد', user = 42) => {
    await f.dispatch({ update_id: id, message: { from: { id: user }, chat: { id: user, type: 'private' }, text } });
    return calls.findLast(c => c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('chpick:'));
  };
  f.click = (offer, id = 1001, user = 42, message = undefined) => f.dispatch({ update_id: id, callback_query: { id: 'callback-' + id, data: offer.body.reply_markup.inline_keyboard[0][0].callback_data, from: { id: user }, message: { message_id: message || messageId, chat: { id: user, type: 'private' } } } });
  return f;
}

test('default async path ingests source-only posts, offers on explicit request and forwards original with caption only after consent', async t => {
  const f = fixture(t); assert.equal((await f.dispatch(post(), 'forged')).status, 403); assert.equal(f.library.state.size, 0);
  await f.dispatch(post(2, { chat: { id: -100555, type: 'channel', username: 'other' } })); assert.equal(f.library.state.size, 0);
  await f.dispatch(post()); assert.equal(f.sessions.size, 0); assert.equal(f.calls.length, 0);
  const offer = await f.ask(); assert.ok(offer); assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  const bound = f.stores.get('42').state.get('session').channelOffers[0].messageId;
  await f.click(offer, 1001, 42, bound);
  const forwards = f.calls.filter(c => c.url.endsWith('/forwardMessage'));
  assert.equal(forwards.length, 1); assert.deepEqual(forwards[0].body, { chat_id: 42, from_chat_id: CHANNEL, message_id: 1 });
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
  await f.click(offer, 1002, 42, bound); await f.click(offer, 1002, 42, bound);
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
});

test('callback tokens cannot be used by another private user, another message or after expiry', async t => {
  const f = fixture(t); await f.dispatch(post()); const offer = await f.ask();
  const bound = f.stores.get('42').state.get('session').channelOffers[0].messageId;
  await f.click(offer, 1001, 43, bound); await f.click(offer, 1002, 42, bound + 1);
  f.advance(11 * 60000); await f.click(offer, 1003, 42, bound);
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  assert.equal(f.stores.get('42').state.get('session').channelOffers.length, 0);
});

test('channel protection and edits revoke existing offers without fallback to cached file IDs', async t => {
  const f = fixture(t); await f.dispatch(post()); const offer = await f.ask();
  let bound = f.stores.get('42').state.get('session').channelOffers[0].messageId;
  const edited = post(1, { caption: 'edited' }); edited.update_id = 5; edited.edited_channel_post = edited.channel_post; delete edited.channel_post;
  await f.dispatch(edited); await f.click(offer, 1001, 42, bound);
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  f.advance(11000); const second = await f.ask(1002, '/song');
  bound = f.stores.get('42').state.get('session').channelOffers.at(-1).messageId;
  f.protected = true; await f.click(second, 1003, 42, bound);
  assert.equal(f.calls.filter(c => /\/(forwardMessage|sendAudio|sendVideo|copyMessage)$/.test(c.url)).length, 0);
});

test('a possibly successful forward is never retried after timeout and the unavailable post stops being recommended', async t => {
  const f = fixture(t); await f.dispatch(post()); const offer = await f.ask();
  const bound = f.stores.get('42').state.get('session').channelOffers[0].messageId;
  f.forwardFails = true; await f.click(offer, 1001, 42, bound);
  f.advance(11000); await f.click(offer, 1002, 42, bound);
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
  const row = (await (await rpc(f.catalogue, 'get', { channelId: CHANNEL, id: 1 })).json()).value; assert.equal(row, null);
  assert.ok(!f.calls.at(-1).body.text.includes('private-failure'));
});

test('membership is checked before recommendation and again before forwarding, while reset clears private offers not the public catalogue', async t => {
  const f = fixture(t); delete f.env.JOIN_REQUIRED; await f.dispatch(post()); f.member = 'left';
  await f.ask(); assert.equal(f.calls.filter(c => c.url.endsWith('/getChat')).length, 0);
  f.member = 'member'; f.advance(5000); const offer = await f.ask(1001);
  const bound = f.stores.get('42').state.get('session').channelOffers[0].messageId;
  f.member = 'left'; await f.click(offer, 1002, 42, bound);
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  await f.ask(1003, '/reset');
  assert.equal(f.stores.get('42').state.get('session').channelOffers, undefined);
  assert.equal(f.library.state.get('channelPosts').length, 1);
});

test('plain conversation never triggers unsolicited channel media', async t => {
  const f = fixture(t); await f.dispatch(post()); await f.ask(1000, 'دلم گرفته');
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  assert.equal(f.calls.filter(c => c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('chpick:')).length, 0);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
});

test('video and quote forwarding preserve independent image/voice/Instagram budgets and use no generation API', async t => {
  const f = fixture(t);
  await f.dispatch(post(2, { audio: undefined, video: { file_id: 'large-video-no-download' }, caption: '#غمگین' }));
  await f.dispatch(post(3, { audio: undefined, text: 'یک قدم کوچیک بردار #انگیزشی' }));
  await f.ask(1000, '/channel'); const store = f.stores.get('42');
  const media = { image: 5, voice: 3, expiresAt: Date.now() + 86400000 }, instagram = { video: 5, music: 5, expiresAt: Date.now() + 86400000 };
  store.state.set('mediaUsage', structuredClone(media)); store.state.set('instagramUsage', structuredClone(instagram));
  f.advance(11000); let offer = await f.ask(1001, '/clip غمگین');
  await f.click(offer, 1002, 42, store.state.get('session').channelOffers.at(-1).messageId);
  f.advance(11000); offer = await f.ask(1003, '/quote انگیزشی');
  await f.click(offer, 1004, 42, store.state.get('session').channelOffers.at(-1).messageId);
  assert.deepEqual(f.calls.filter(c => c.url.endsWith('/forwardMessage')).map(c => c.body.message_id), [2, 3]);
  assert.deepEqual(store.state.get('mediaUsage'), media); assert.deepEqual(store.state.get('instagramUsage'), instagram);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai') || /sendVideo|sendAudio|getFile|copyMessage/.test(c.url)).length, 0);
});

test('pending private channel offers are capped at three and their expiry keeps a cleanup alarm', async t => {
  const f = fixture(t); await f.dispatch(post());
  for (let i = 0; i < 5; i++) { f.advance(5000); await f.ask(1000 + i); }
  const store = f.stores.get('42'); assert.equal(store.state.get('session').channelOffers.length, 3);
  const firstExpiry = Math.min(...store.state.get('session').channelOffers.map(o => o.expiresAt));
  assert.ok(store.alarm <= firstExpiry);
  f.advance(11 * 60000); await f.sessions.get('42').alarm();
  assert.equal(store.state.get('session').channelOffers.length, 0);
});

test('default direct requests send original channel content without a confirmation step or extra model calls', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED; await f.dispatch(post());
  await f.ask(); assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
  assert.equal(f.stores.get('42').state.get('session').channelOffers, undefined);
  assert.ok(!f.calls.some(c => c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('chpick:')));
  await f.ask(); assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
});

test('automatic requests remain fail-closed when a user leaves or the channel becomes protected', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED; delete f.env.JOIN_REQUIRED; await f.dispatch(post());
  f.member = 'left'; await f.ask(); assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  f.member = 'member'; f.protected = true; f.advance(5000); await f.ask(1001);
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
});

test('positive contextual weather matching is literal, topic-specific, conservative and never a sensitive mood inference', () => {
  assert.equal(positiveWeatherContext('عاشق بارونم').kind, 'rain');
  assert.equal(positiveWeatherContext('بارون رو دوست دارم').kind, 'rain');
  assert.equal(positiveWeatherContext('هوای ابری حس خوبی داره').kind, 'cloud');
  assert.equal(positiveWeatherContext('برف قشنگه').kind, 'snow');
  for (const text of ['دلم گرفته', 'از بارون میترسم', 'برف قشنگه ولی خسارت زد', 'عاشق بارون بودم ولی الان متنفرم', '/weather', 'بارون قشنگه ولی آهنگ نفرست', 'عاشق برفم میخوام بمیرم']) assert.equal(positiveWeatherContext(text), null, text);
  const rows = [ { id: 1, kind: 'song', date: 1, text: '#باران', expiresAt: Date.now() + 10000 }, { id: 2, kind: 'video', date: 2, text: '#برف', expiresAt: Date.now() + 10000 }, { id: 3, kind: 'quote', date: 3, text: '#باران خسارت سیل', expiresAt: Date.now() + 10000 } ];
  assert.equal(selectChannelMoment(rows, 'rain').id, 1); assert.equal(selectChannelMoment(rows, 'cloud'), null);
  assert.equal(selectChannelMoment(rows, 'rain', [1]), null);
});

test('contextual posts follow the normal reply, need no second confirmation, and have a durable daily limit', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED;
  await f.dispatch(post(1, { caption: '#بارون #آرام' }));
  await f.ask(1000, '/channelauto');
  await f.ask(1001, 'بارون رو دوست دارم');
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
  const first = f.calls.findIndex(c => c.url.endsWith('/forwardMessage'));
  assert.ok(f.calls.slice(0, first).some(c => c.url.endsWith('/sendMessage') && c.body.text.includes('بیشتر بگو')));
  f.advance(10000); await f.ask(1002, 'بارون رو دوست دارم');
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
  const store = f.stores.get('42'); assert.ok(store.state.get('channelAuto').expiresAt > Date.now());
  assert.ok(!JSON.stringify(store.state.get('channelAuto')).includes('دوست دارم'));
  f.advance(25 * 3600000); await f.sessions.get('42').alarm();
  assert.equal(store.state.has('channelAuto'), false);
});

test('channelstop/reset/global stop preserve opt-outs across restart and do not block a direct channel request', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED; await f.dispatch(post(1, { caption: '#بارون' }));
  await f.ask(1000, '/channelauto'); await f.ask(1001, '/channelstop'); f.advance(5000); await f.ask(1002, 'بارون رو دوست دارم');
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  await f.ask(1003, '/start'); assert.equal(f.stores.get('42').state.get('channelOptOut'), true);
  f.advance(5000); await f.ask(1004, '/song'); assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
  await f.ask(1005, '/channelauto'); await f.ask(1006, '/reset'); assert.equal(f.stores.get('42').state.get('channelOptOut'), true);
  await f.ask(1007, '/channelauto'); await f.ask(1008, '/stop'); assert.equal(f.stores.get('42').state.get('channelOptOut'), true);
});

test('legacy opt-outs and hazardous/irrelevant contexts never trigger automatic attachments', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED; await f.dispatch(post(1, { caption: '#بارون' }));
  await f.ask(1000, 'بارون رو دوست دارم'); // Fixture has pre-existing /stop preferences.
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  await f.ask(1001, '/channelauto'); f.advance(5000); await f.ask(1002, 'برف رو دوست دارم');
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0); // No matching snow post.
  await f.sessions.get('42').maybeSendChannelMoment(42, { kind: 'rain', severe: true });
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
});

test('a busy media lease quietly omits the optional post without charging a model or leaking capacity', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED; await f.dispatch(post(1, { caption: '#بارون' })); await f.ask(1000, '/channelauto');
  await rpc(f.capacity, 'ignored', { op: 'admit', id: 'u99000' });
  await rpc(f.capacity, 'ignored', { op: 'start', id: 'u99000', kind: 'media' });
  await f.sessions.get('42').maybeSendChannelMoment(42, { kind: 'rain', severe: false });
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
  assert.equal(f.capacityStore.state.get('workTickets').length, 1);
});

test('weather composition sends factual clouds plus a sentence, then an optional matching native post only once', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED; delete f.env.JOIN_REQUIRED;
  await f.dispatch(post(1, { caption: '#ابری #آرام' })); await f.ask(1000, '/channelauto');
  const store = f.stores.get('42'); store.state.delete('weatherOptOut');
  const original = f.env.fetchImpl;
  f.env.fetchImpl = async (url, options) => {
    if (new URL(url).hostname === 'api.open-meteo.com') {
      const hour = Math.floor(Date.now() / 3600000) * 3600;
      return Response.json({ timezone: 'Asia/Tehran', current: { time: Math.floor(Date.now() / 1000), temperature_2m: 13, weather_code: 3, cloud_cover: 95 }, hourly: { time: [hour, hour + 3600, hour + 7200], weather_code: [3, 3, 3], cloud_cover: [95, 95, 95], precipitation_probability: [0, 0, 0], rain: [0, 0, 0], snowfall: [0, 0, 0] } });
    }
    return original(url, options);
  };
  store.state.set('weather', { city: { name: 'آباده', latitude: 31.16, longitude: 52.65 }, chatId: 42, alertsEnabled: true, nextCheckAt: Date.now() - 1 });
  await f.sessions.get('42').alarm();
  assert.ok(f.calls.some(c => c.url.endsWith('/sendMessage') && c.body.text.includes('آسمون ابریه') && c.body.text.includes('Open-Meteo')));
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  assert.equal(f.capacityStore.state.get('workTickets').length, 0);
  await f.sessions.get('42').alarm(); assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 1);
});

test('late weather errors preserve an already stored event claim rather than retrying paid generation', async t => {
  const f = fixture(t); await f.ask(1000, '/channel'); const store = f.stores.get('42'), session = f.sessions.get('42');
  const original = { alertsEnabled: true, nextCheckAt: Date.now() - 1, chatId: 42 };
  store.state.set('weather', original);
  session.weather.alarm = async () => { store.state.set('weather', { ...original, lastAlertAt: Date.now(), lastEventAt: Date.now() + 3600000 }); throw new Error('late transient failure'); };
  await session.runWeatherAlarm(original);
  assert.ok(store.state.get('weather').lastAlertAt); assert.ok(store.state.get('weather').nextCheckAt > Date.now());
});

test('leaving during an ordinary chat reply blocks the contextual file despite initial membership', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED; delete f.env.JOIN_REQUIRED;
  await f.dispatch(post(1, { caption: '#بارون' })); await f.ask(1000, '/channelauto');
  const original = f.env.fetchImpl;
  f.env.fetchImpl = async (url, options) => { const response = await original(url, options); if (url.includes('openrouter.ai')) f.member = 'left'; return response; };
  await f.ask(1001, 'بارون رو دوست دارم');
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  assert.equal(f.stores.get('42').state.has('channelAuto'), false);
});

test('an optional contextual-storage failure cannot turn an already delivered chat answer into a failure message', async t => {
  const f = fixture(t); delete f.env.CHANNEL_CONFIRMATION_REQUIRED;
  await f.dispatch(post(1, { caption: '#بارون' })); await f.ask(1000, '/channelauto');
  const store = f.stores.get('42'), get = store.storage.get;
  store.storage.get = async key => { if (key === 'channelOptOut') throw new Error('transient private-storage failure'); return get(key); };
  await f.ask(1001, 'بارون رو دوست دارم');
  assert.equal(f.calls.filter(c => c.url.endsWith('/forwardMessage')).length, 0);
  assert.ok(f.calls.filter(c => c.url.endsWith('/sendMessage')).at(-1).body.text.includes('بیشتر بگو'));
});

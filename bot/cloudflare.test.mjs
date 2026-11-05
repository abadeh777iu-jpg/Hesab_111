import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, ChatSession, FOLLOWUP_DELAY, FOLLOWUP_TEXT, FOLLOWUP_NOTICE } from './cloudflare.mjs';
import { START_GREETING } from './core.mjs';
import { MediaBudgetHandler, nextMediaDay } from './media.mjs';

function update(id = 1, text = 'سلام', user = 42) {
  return { update_id: id, message: { chat: { id: user, type: 'private' }, from: { id: user }, text } };
}
function setup() {
  const state = new Map();
  let alarmAt;
  const storage = {
    get: async key => structuredClone(state.get(key)),
    put: async (key, value) => state.set(key, structuredClone(value)),
    setAlarm: async at => { alarmAt = at; },
    delete: async key => state.delete(key),
    deleteAlarm: async () => { alarmAt = undefined; },
    deleteAll: async () => state.clear(),
  };
  const calls = [];
  const env = {
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret', JOIN_REQUIRED: 'false', BOT_ASYNC_UPDATES: 'false',
    OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'test/model', TELEGRAM_ALLOWED_USER_IDS: '42',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify(url.includes('openrouter.ai')
        ? { choices: [{ message: { content: 'دوست داری بیشتر بگی؟' } }] } : { ok: true }));
    },
  };
  const session = new ChatSession({ storage }, env);
  env.CHATS = {
    idFromName: name => name,
    get: () => ({ fetch: (url, options) => session.fetch(new Request(url, options)) }),
  };
  return { env, calls, state, session, storage, alarmAt: () => alarmAt };
}
function request(body, secret = 'test-secret') {
  return new Request('https://example.workers.dev/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body),
  });
}

test('webhook rejects absent configuration and forged requests before processing', async () => {
  const worker = createWorker();
  const { env, calls } = setup();
  assert.equal((await worker.fetch(request(update(), 'wrong'), env)).status, 403);
  assert.equal((await worker.fetch(request(update()), { ...env, TELEGRAM_WEBHOOK_SECRET: '' })).status, 503);
  assert.equal((await worker.fetch(request(update()), { ...env, TELEGRAM_ALLOWED_USER_IDS: '' })).status, 503);
  assert.equal(calls.length, 0);
});

test('invalid updates, oversized bodies, groups and unauthorized users never reach AI', async () => {
  const worker = createWorker();
  const { env, calls } = setup();
  assert.equal((await worker.fetch(request({ nope: true }), env)).status, 400);
  assert.equal((await worker.fetch(request({ data: 'x'.repeat(70_000) }), env)).status, 400);
  assert.equal((await worker.fetch(request(update(1, 'سلام', 99)), env)).status, 200);
  const group = update(); group.message.chat.type = 'group';
  await worker.fetch(request(group), env);
  await worker.fetch(request({ update_id: 5, edited_message: update().message }), env);
  assert.equal(calls.length, 0);
});

test('verified private message gets a short greeting, reply, bounded stored history and cleanup alarm', async () => {
  const worker = createWorker();
  const { env, state, calls, alarmAt } = setup();
  assert.equal((await worker.fetch(request(update()), env)).status, 200);
  const completions = calls.filter(c => c.url.includes('openrouter.ai'));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].body.messages[1].content, 'سلام');
  const sent = calls.filter(c => c.url.includes('sendMessage'));
  assert.equal(sent[0].body.text, `${START_GREETING}\n\n${FOLLOWUP_NOTICE}`);
  assert.equal(state.get('session').messages.length, 2);
  assert.ok(alarmAt() > Date.now());
});

test('simultaneous duplicate updates incur only one model request', async () => {
  const worker = createWorker();
  const { env, calls } = setup();
  await Promise.all([worker.fetch(request(update()), env), worker.fetch(request(update()), env)]);
  assert.equal(calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
});

test('history survives object recreation and is included on subsequent requests', async () => {
  const { env, storage, state, calls } = setup();
  const worker = createWorker();
  await worker.fetch(request(update()), env);
  const record = state.get('session'); record.lastAt = 0; state.set('session', record);
  const recreated = new ChatSession({ storage }, env);
  await recreated.fetch(request(update(2, 'خسته‌ام')));
  const modelCalls = calls.filter(c => c.url.includes('openrouter.ai'));
  assert.equal(modelCalls[1].body.messages.length, 4); // system + previous pair + new user
});

test('/reset clears sensitive history and alarm removes expired sessions', async () => {
  const { env, state, session } = setup();
  const worker = createWorker();
  await worker.fetch(request(update()), env);
  await worker.fetch(request(update(2, '/reset')), env);
  assert.deepEqual(state.get('session').messages, []);
  const record = state.get('session'); record.expiresAt = Date.now() - 1; state.set('session', record);
  await session.alarm();
  assert.equal(state.has('session'), false);
  assert.deepEqual(state.get('followup'), { disabled: true, noticeShown: true, dueAt: null });
});

test('provider failure produces generic error and retries do not charge again', async () => {
  const { env, calls } = setup();
  const original = env.fetchImpl;
  let attempts = 0;
  env.fetchImpl = async (url, options) => {
    if (url.includes('openrouter.ai')) { attempts++; return new Response('private error details', { status: 429 }); }
    return original(url, options);
  };
  const worker = createWorker();
  await worker.fetch(request(update()), env);
  await worker.fetch(request(update()), env);
  assert.equal(attempts, 1);
  assert.ok(calls.at(-1).body.text.includes('نتونستم'));
  assert.ok(!JSON.stringify(calls).includes('private error details'));
});

test('commands and non-text input do not call model', async () => {
  const worker = createWorker();
  const { env, calls } = setup();
  for (const [index, text] of ['/start', '/about', '/privacy', '/help', '/reset', '', 'x'.repeat(6001)].entries()) {
    await worker.fetch(request(update(index, text)), env);
  }
  assert.equal(calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
});

test('30 stored messages retain the most recent 15 turns', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, calls } = setup();
  const worker = createWorker();
  for (let id = 1; id <= 17; id++) {
    await worker.fetch(request(update(id, `message-${id}`)), env);
    now += 5000;
  }
  const messages = state.get('session').messages;
  assert.equal(messages.length, 30);
  assert.equal(messages[0].content, 'message-3');
  assert.equal(messages.at(-2).content, 'message-17');
  const lastRequest = calls.filter(call => call.url.includes('openrouter.ai')).at(-1);
  assert.equal(lastRequest.body.messages.length, 32); // system + 30 prior messages + new input
});

test('automatic check-in follows the disclosure without requiring an opt-in command', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, calls, session, alarmAt } = setup();
  await createWorker().fetch(request(update()), env);
  calls.length = 0;
  now += FOLLOWUP_DELAY + 1;
  await session.alarm();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, FOLLOWUP_TEXT);
  assert.equal(state.has('session'), false);
  assert.equal(state.get('followup').dueAt, null);
  assert.equal(alarmAt(), state.get('weather').nextCheckAt);
});

test('opt-in survives history cleanup and object recreation; one check-in after 24h, no AI call', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, storage, calls, session, alarmAt } = setup();
  state.set('weatherOptOut', true); // Isolate the check-in alarm from default weather.
  await createWorker().fetch(request(update(1, '/followup')), env);
  const dueAt = now + FOLLOWUP_DELAY;
  assert.equal(state.get('followup').dueAt, dueAt);
  assert.equal(state.get('followup').chatId, 42);
  calls.length = 0;
  now += 31 * 60_000;
  await session.alarm();
  assert.equal(state.has('session'), false);
  assert.equal(state.has('followup'), true);
  assert.equal(alarmAt(), dueAt);
  assert.equal(calls.length, 0);
  const recreated = new ChatSession({ storage }, env);
  now = dueAt - 1;
  await recreated.alarm();
  assert.equal(calls.length, 0);
  now = dueAt;
  await recreated.alarm();
  await recreated.alarm();
  now += FOLLOWUP_DELAY;
  await recreated.alarm();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/sendMessage'));
  assert.equal(calls[0].body.text, FOLLOWUP_TEXT);
  assert.equal(state.get('followup').dueAt, null);
  assert.equal(alarmAt(), undefined);
});

test('new text rearms the timer, duplicate webhook does not, completed check-in can rearm', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, session } = setup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/followup')), env);
  now += 60_000;
  await worker.fetch(request(update(2, 'دارم درس می‌خونم')), env);
  const dueAt = now + FOLLOWUP_DELAY;
  assert.equal(state.get('followup').dueAt, dueAt);
  now += 60_000;
  await worker.fetch(request(update(2, 'دارم درس می‌خونم')), env);
  assert.equal(state.get('followup').dueAt, dueAt);
  now = dueAt;
  await session.alarm();
  assert.equal(state.get('followup').dueAt, null);
  now += 5000;
  await worker.fetch(request(update(3, 'سلام دوباره')), env);
  assert.equal(state.get('followup').dueAt, now + FOLLOWUP_DELAY);
});

test('/stop and /reset cancel scheduled check-ins and retain an opt-out without a chat ID', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const command of ['/stop', '/reset']) {
    const { env, state, calls, session } = setup();
    const worker = createWorker();
    await worker.fetch(request(update(1, '/followup')), env);
    await worker.fetch(request(update(2, command)), env);
    assert.deepEqual(state.get('followup'), { disabled: true, noticeShown: true, dueAt: null });
    calls.length = 0;
    now += FOLLOWUP_DELAY + 1;
    await session.alarm();
    assert.equal(calls.length, 0);
  }
});

test('failed delivery or revoked access clears routing data and suppresses follow-ups without retries', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const mode of ['blocked', 'revoked']) {
    const { env, state, calls, session } = setup();
    await createWorker().fetch(request(update(1, '/followup')), env);
    calls.length = 0;
    now += FOLLOWUP_DELAY;
    let attempts = 0;
    if (mode === 'revoked') env.TELEGRAM_ALLOWED_USER_IDS = '99';
    else env.fetchImpl = async () => { attempts++; return new Response('{}', { status: 403 }); };
    await session.alarm();
    await session.alarm();
    assert.deepEqual(state.get('followup'), { disabled: true, noticeShown: true, dueAt: null });
    assert.equal(attempts, mode === 'blocked' ? 1 : 0);
    assert.equal(calls.length, 0);
  }
});

test('Cloudflare opinion replies use escaped native Telegram blockquotes', async () => {
  const { env, calls } = setup();
  const original = env.fetchImpl;
  env.fetchImpl = async (url, options) => url.includes('openrouter.ai')
    ? new Response(JSON.stringify({ choices: [{ message: { content: 'می‌فهمم 🌱\n[OPINION]به نظرم <قدم اول> رو بردار 💪[/OPINION]' } }] }))
    : original(url, options);
  await createWorker().fetch(request(update()), env);
  const reply = calls.at(-1).body;
  assert.equal(reply.parse_mode, 'HTML');
  assert.ok(reply.text.includes('<blockquote>'));
  assert.ok(reply.text.includes('&lt;قدم اول&gt;'));
  assert.ok(!reply.text.includes('[OPINION]'));
});

test('first /start sends one greeting with a brief notice, no AI call or privacy wall', async () => {
  const { env, calls, state } = setup();
  await createWorker().fetch(request(update(1, '/start')), env);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/sendMessage'));
  assert.equal(calls[0].body.text, `${START_GREETING}\n\n${FOLLOWUP_NOTICE}`);
  assert.deepEqual(state.get('session').messages, []);
});

test('/about and /privacy retain identity and data disclosures on demand', async () => {
  const { env, calls } = setup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/about')), env);
  const aboutCount = calls.length; assert.ok(aboutCount >= 1 && aboutCount <= 2);
  assert.ok(calls[0].body.text.includes('هوش مصنوعی'));
  assert.ok(calls[0].body.text.includes('پاسخ زندهٔ شخص امیر نیست'));
  await worker.fetch(request(update(2, '/privacy')), env);
  const privacy = calls.slice(aboutCount).map(c => c.body.text).join('');
  assert.ok(privacy.includes('۳۰ پیام'));
  assert.ok(privacy.includes('OpenRouter'));
  assert.ok(privacy.includes('/stop'));
  assert.ok(privacy.includes('۱۰ دقیقه'));
  assert.ok(calls.every(c => c.url.endsWith('/sendMessage') && c.body.text.length <= 4000));
});

test('text after /start does not trigger another greeting or explanation', async () => {
  const { env, calls } = setup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/start')), env);
  calls.length = 0;
  await worker.fetch(request(update(2, 'سلام، خوبم')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 1);
  const sent = calls.filter(call => call.url.includes('sendMessage'));
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].body.text.includes('OpenRouter'));
});

test('notice is shown once and survives history expiry and object recreation', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, storage, calls, session } = setup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/start')), env);
  assert.ok(calls[0].body.text.includes(FOLLOWUP_NOTICE));
  now += 31 * 60_000;
  await session.alarm();
  assert.equal(state.has('session'), false);
  const recreated = new ChatSession({ storage }, env);
  calls.length = 0;
  await recreated.fetch(request(update(2, '/start')));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, START_GREETING);
  assert.equal(state.get('followup').dueAt, now + FOLLOWUP_DELAY);
});

test('opt-out survives new texts, history expiry, recreation and /start until explicit re-enable', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const command of ['/stop', '/reset']) {
    const { env, state, storage, calls, session } = setup();
    const worker = createWorker();
    await worker.fetch(request(update(1, '/start')), env);
    await worker.fetch(request(update(2, command)), env);
    now += 31 * 60_000;
    await session.alarm();
    const recreated = new ChatSession({ storage }, env);
    await recreated.fetch(request(update(3, 'سلام دوباره')));
    await recreated.fetch(request(update(4, '/start')));
    assert.deepEqual(state.get('followup'), { disabled: true, noticeShown: true, dueAt: null });
    calls.length = 0;
    now += FOLLOWUP_DELAY;
    await recreated.alarm();
    assert.equal(calls.length, 0);
    await recreated.fetch(request(update(5, '/followup')));
    assert.equal(state.get('followup').disabled, false);
    assert.equal(state.get('followup').dueAt, now + FOLLOWUP_DELAY);
  }
});

test('an existing session is notified before automatic outreach is enabled', async () => {
  const { env, state, calls } = setup();
  state.set('session', { messages: [], seen: [], lastAt: 0, introduced: true, expiresAt: Date.now() + 60_000 });
  await createWorker().fetch(request(update()), env);
  assert.equal(calls[0].body.text, FOLLOWUP_NOTICE);
  assert.equal(state.get('followup').noticeShown, true);
});

test('if first disclosure cannot be delivered, no automatic follow-up is armed', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, session } = setup();
  let attempts = 0;
  env.fetchImpl = async () => { attempts++; return new Response('{}', { status: 403 }); };
  await createWorker().fetch(request(update(1, '/start')), env);
  assert.equal(state.has('followup'), false);
  const before = attempts;
  now += FOLLOWUP_DELAY;
  await session.alarm();
  assert.equal(attempts, before);
});

test('natural price questions use the shared market binding, not model guesses', async () => {
  const { env, calls } = setup();
  let feedCalls = 0;
  env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => {
    feedCalls++; return new Response('نرخ معتبر منبع؛ زمان اعلام‌شده');
  } }) };
  await createWorker().fetch(request(update(1, 'قیمت دلار چنده؟')), env);
  assert.equal(feedCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.text, FOLLOWUP_NOTICE);
  assert.equal(calls[1].body.text, 'نرخ معتبر منبع؛ زمان اعلام‌شده');
});

test('live query rate limiting avoids repeated external requests', async () => {
  const { env, calls } = setup();
  let feedCalls = 0;
  env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => { feedCalls++; return new Response('quote'); } }) };
  const worker = createWorker();
  await worker.fetch(request(update(1, '/prices')), env);
  await worker.fetch(request(update(2, '/prices')), env);
  assert.equal(feedCalls, 1);
  assert.ok(calls.at(-1).body.text.includes('چند ثانیه'));
});

test('/stop disables all outreach while /reset also deletes the saved city', async () => {
  for (const command of ['/stop', '/reset']) {
    const { env, state } = setup();
    state.set('weather', { city: { name: 'Tehran', latitude: 35.69, longitude: 51.39 }, chatId: 42, alertsEnabled: true, nextCheckAt: Date.now() + 1000 });
    await createWorker().fetch(request(update(1, command)), env);
    assert.equal(state.get('followup').disabled, true);
    if (command === '/reset') assert.equal(state.has('weather'), false);
    else {
      assert.equal(state.get('weather').alertsEnabled, false);
      assert.equal(state.get('weather').nextCheckAt, null);
    }
  }
});

test('chat activity and follow-up scheduling preserve the earlier weather alarm', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, alarmAt, session } = setup();
  state.set('weather', { city: { name: 'Tehran', latitude: 35.69, longitude: 51.39 }, chatId: 42, alertsEnabled: true, nextCheckAt: now + 1000 });
  await createWorker().fetch(request(update(1, '/start')), env);
  assert.equal(alarmAt(), now + 1000);
  now += 1000;
  const original = env.fetchImpl;
  env.fetchImpl = async (url, options) => url.includes('open-meteo')
    ? new Response('{}', { status: 503 }) : original(url, options);
  await session.alarm();
  assert.equal(state.get('weather').nextCheckAt, now + 3600000);
  assert.equal(state.get('followup').dueAt, now - 1000 + FOLLOWUP_DELAY);
  assert.ok(alarmAt() < state.get('weather').nextCheckAt); // 30-minute history cleanup still wins
});

test('first start automatically enrolls Abadeh weather after one combined notice', async () => {
  const { env, state, calls } = setup();
  await createWorker().fetch(request(update(1, '/start')), env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, `${START_GREETING}\n\n${FOLLOWUP_NOTICE}`);
  assert.ok(!/هوا|باران|برف|آباده/.test(calls[0].body.text));
  assert.equal(state.get('weather').city.name, 'آباده، استان فارس');
  assert.equal(state.get('weather').alertsEnabled, true);
});

test('existing conversations receive a brief weather notice once, without a city question', async () => {
  const { env, state, calls } = setup();
  state.set('followup', { chatId: 42, dueAt: Date.now() + FOLLOWUP_DELAY, noticeShown: true });
  const worker = createWorker();
  await worker.fetch(request(update(1, '/start')), env);
  assert.equal(calls.length, 1); // Previously delivered generic notice is reused.
  assert.ok(!/هوا|باران|برف|آباده/.test(calls[0].body.text));
  assert.ok(!calls[0].body.text.includes('کدوم'));
  calls.length = 0;
  await worker.fetch(request(update(2, '/start')), env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, START_GREETING);
});

test('automatic Abadeh alerts do not reactivate after /stop or /reset and a new /start', async () => {
  for (const command of ['/stop', '/reset']) {
    const { env, state } = setup();
    const worker = createWorker();
    await worker.fetch(request(update(1, '/start')), env);
    await worker.fetch(request(update(2, command)), env);
    await worker.fetch(request(update(3, '/start')), env);
    assert.equal(state.get('weatherOptOut'), true);
    assert.ok(!state.get('weather')?.alertsEnabled);
  }
});

test('/test_snow sends only to its requesting chat, without enrolling or changing subscriptions', async () => {
  const { env, state, calls } = setup();
  await createWorker().fetch(request(update(1, '/test_snow 99')), env);
  const sent = calls.filter(call => call.url.endsWith('/sendMessage'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, 42); // extra arguments cannot redirect a test
  assert.ok(sent[0].body.text.startsWith('🧪 آزمایشی'));
  assert.equal(state.has('weather'), false);
  assert.equal(state.has('followup'), false);
  assert.ok(state.has('snowPreview'));
  assert.equal(calls.filter(call => call.url.includes('open-meteo')).length, 0);
});

test('snow preview metadata gets a cleanup alarm independent of conversation history', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, calls, session, alarmAt } = setup();
  await createWorker().fetch(request(update(1, '/test_snow')), env);
  calls.length = 0;
  now += 31 * 60_000;
  await session.alarm();
  assert.equal(state.has('session'), false);
  assert.equal(alarmAt(), state.get('snowPreview').expiresAt);
  now += 30 * 60_000;
  await session.alarm();
  assert.equal(state.has('snowPreview'), false);
  assert.equal(alarmAt(), undefined);
  assert.equal(calls.length, 0);
});

function mediaSetup() {
  const rig = setup();
  rig.env.FREEAI_API_KEY = 'freeai-secret';
  const budgetState = new Map();
  const budget = new MediaBudgetHandler({ storage: {
    get: async key => structuredClone(budgetState.get(key)),
    put: async (key, value) => budgetState.set(key, structuredClone(value)),
    setAlarm: async () => {}, delete: async key => budgetState.delete(key),
  } });
  rig.env.MEDIA = {
    idFromName: name => name,
    get: () => ({ fetch: (url, options) => budget.fetch(new Request(url, options)) }),
  };
  rig.env.fetchImpl = async (url, options) => {
    rig.calls.push({ url, body: options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/v1/image/generate/')) return Response.json({ image_url: '/static/outputs/image.png' });
    if (url === 'https://api.free.ai/static/outputs/image.png') return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), { headers: { 'Content-Type': 'image/png' } });
    if (url.endsWith('/audio/speech')) {
      if (rig.env.failSpeech) return Response.json({ error: 'private upstream detail' }, { status: 402 });
      return new Response(Uint8Array.from([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: 'با یه قدم کوچیک شروع کن 🌱' } }] });
    return Response.json({ ok: true });
  };
  return { ...rig, budgetState };
}

test('explicit image request uploads one real file only to the requester, default weather without a check-in timer or duplicate charge', async () => {
  const { env, state, calls, budgetState } = mediaSetup();
  const worker = createWorker();
  await Promise.all([worker.fetch(request(update(1, '/image freeai کلبه برفی')), env), worker.fetch(request(update(1, '/image freeai کلبه برفی')), env)]);
  assert.equal(calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 1);
  const uploads = calls.filter(call => call.url.endsWith('/sendPhoto'));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.get('chat_id'), '42');
  assert.equal(uploads[0].body.get('photo').type, 'image/png');
  assert.equal(state.get('weather').alertsEnabled, true);
  assert.equal(state.get('followup').dueAt, undefined);
  assert.equal(state.get('mediaUsage').image, 1);
  assert.equal(budgetState.get('budget').image, 1);
  assert.deepEqual(state.get('session').messages, []); // no image/prompt persistence
});

test('voice question preserves readable response and history, then sends an AI-labeled voice note', async () => {
  const { env, state, calls } = mediaSetup();
  await createWorker().fetch(request(update(1, 'با ویس جواب بده، چطور کارمو شروع کنم؟')), env);
  assert.equal(calls.filter(call => call.url.endsWith('/chat/completions')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/speech')).length, 1);
  const voice = calls.find(call => call.url.endsWith('/sendVoice'));
  assert.equal(voice.body.get('chat_id'), '42');
  assert.ok(voice.body.get('caption').includes('صدای واقعی شخص امیر نیست'));
  assert.equal(voice.body.get('voice').type, 'audio/mpeg');
  assert.ok(calls.some(call => call.url.endsWith('/sendMessage') && call.body.text.includes('یه قدم کوچیک')));
  assert.equal(state.get('session').messages.length, 2);
  assert.equal(state.get('weather').alertsEnabled, true);
  assert.equal(state.get('followup').dueAt, undefined);
});

test('/voice reuses the last answer without another chat-model charge', async () => {
  const { env, state, calls } = mediaSetup();
  state.set('session', { expiresAt: Date.now() + 60_000, seen: [], messages: [{ role: 'assistant', content: 'یه قدم کوچیک بردار 🌱' }], lastAt: 0 });
  await createWorker().fetch(request(update(1, '/voice')), env);
  assert.equal(calls.filter(call => call.url.endsWith('/chat/completions')).length, 0);
  assert.equal(calls.find(call => call.url.endsWith('/audio/speech')).body.input, 'یه قدم کوچیک بردار');
  assert.equal(calls.filter(call => call.url.endsWith('/sendVoice')).length, 1);
});

test('empty/oversized prompts, disabled media, groups and unauthorized users spend no media budget', async () => {
  const { env, calls, state, budgetState } = mediaSetup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/image')), env);
  await worker.fetch(request(update(2, '/voice')), env);
  await worker.fetch(request(update(3, '/image freeai ' + 'a'.repeat(2001))), env);
  await worker.fetch(request(update(4, '/image freeai snow', 99)), env);
  const group = update(5, '/image freeai snow'); group.message.chat.type = 'group';
  await worker.fetch(request(group), env);
  env.MEDIA_ENABLED = 'false';
  await worker.fetch(request(update(6, '/image freeai snow')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter')).length, 0);
  assert.equal(state.has('mediaUsage'), false);
  assert.equal(budgetState.size, 0);
});

test('personal daily limits and shared cooldown survive /reset, history expiry and object recreation', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, storage, calls, state } = mediaSetup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/voice شروع کار')), env);
  await worker.fetch(request(update(2, '/image freeai snow')), env);
  assert.ok(calls.at(-1).body.text.includes('یک دقیقه'));
  now += 60_000;
  await worker.fetch(request(update(3, '/image freeai snow')), env);
  for (let id = 20; id < 24; id++) {
    now += 60_000;
    await worker.fetch(request(update(id, '/image freeai snow')), env);
  }
  await worker.fetch(request(update(4, '/reset')), env);
  now += 31 * 60_000;
  const recreated = new ChatSession({ storage }, env);
  await recreated.fetch(request(update(5, '/image freeai snow')));
  assert.ok(calls.at(-1).body.text.includes('سهمیهٔ امروزت'));
  await recreated.fetch(request(update(6, '/voice دوباره شروع')));
  now += 60_000;
  await recreated.fetch(request(update(7, '/voice قدم بعدی')));
  now += 60_000;
  await recreated.fetch(request(update(8, '/voice بیشتر')));
  assert.ok(calls.at(-1).body.text.includes('سهمیهٔ امروزت'));
  assert.equal(calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 5);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/speech')).length, 3);
  assert.equal(state.get('mediaUsage').voice, 3);
});

test('failed speech keeps the text, consumes an attempt and never leaks raw errors or retries', async () => {
  const { env, calls, state } = mediaSetup();
  env.failSpeech = true;
  const worker = createWorker();
  await worker.fetch(request(update(1, '/voice شروع کار')), env);
  await worker.fetch(request(update(1, '/voice شروع کار')), env);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/speech')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/sendVoice')).length, 0);
  const messages = calls.filter(call => call.url.endsWith('/sendMessage'));
  assert.ok(messages.some(message => message.body.text.includes('یه قدم کوچیک')));
  assert.ok(messages.at(-1).body.text.includes('اعتبار'));
  assert.ok(!JSON.stringify(messages).includes('private upstream'));
  assert.equal(state.get('mediaUsage').voice, 1);
});

test('shared exhausted or unavailable budget fails closed before any paid request', async () => {
  for (const status of [429, 503]) {
    const { env, calls, state } = mediaSetup();
    env.MEDIA.get = () => ({ fetch: async () => new Response('not available', { status }) });
    await createWorker().fetch(request(update(1, '/image freeai snow')), env);
    assert.equal(calls.filter(call => call.url.includes('openrouter')).length, 0);
    assert.equal(state.has('mediaUsage'), false);
    if (status === 429) assert.ok(calls.at(-1).body.text.includes('کل ربات'));
  }
});

test('per-chat budget cleanup alarm survives history expiry and removes only its own data at midnight', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, session, state, calls, alarmAt } = mediaSetup();
  state.set('weatherOptOut', true); // Isolate media cleanup from weather scheduling.
  await createWorker().fetch(request(update(1, '/image freeai snow')), env);
  calls.length = 0;
  now += 31 * 60_000;
  await session.alarm();
  assert.equal(state.has('session'), false);
  assert.equal(alarmAt(), nextMediaDay());
  now = nextMediaDay();
  await session.alarm();
  assert.equal(state.has('mediaUsage'), false);
  assert.equal(alarmAt(), undefined);
  assert.equal(calls.length, 0);
});

function freeAIMediaSetup() {
  const rig = mediaSetup();
  delete rig.env.MEDIA_PROVIDER;
  rig.env.MEDIA_VOICE_PROVIDER = 'freeai'; // explicitly exercise the opt-in Free.ai adapter
  rig.env.FREEAI_API_KEY = 'freeai-secret';
  rig.env.FREEAI_TTS_MODEL = 'configured-persian-model';
  rig.env.FREEAI_TTS_VOICE = 'configured-persian-voice';
  const original = rig.env.fetchImpl;
  rig.env.fetchImpl = async (url, options) => {
    if (new URL(url).hostname !== 'api.free.ai') return original(url, options);
    rig.calls.push({ url, body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
    if (options.method === 'POST') {
      assert.equal(options.headers.Authorization, 'Bearer freeai-secret');
      if (url.endsWith('/v1/image/generate/')) return Response.json({ image_url: '/static/outputs/snow.png' });
      if (url.endsWith('/v1/tts/')) return Response.json({ audio_url: '/static/outputs/voice.mp3' });
      throw new Error('Unexpected Free.ai endpoint');
    }
    assert.equal(options.headers.Authorization, undefined);
    return url.endsWith('.png')
      ? new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), { headers: { 'Content-Type': 'image/png' } })
      : new Response(Uint8Array.from([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
  };
  return rig;
}

test('Free.ai default isolates image/speech from OpenRouter chat and still uses shared media budgets', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, calls, state, budgetState } = freeAIMediaSetup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/image freeai کلبه برفی')), env);
  now += 60_000;
  await worker.fetch(request(update(2, '/voice چطور شروع کنم؟')), env);
  const router = calls.filter(call => call.url.includes('openrouter.ai'));
  assert.equal(router.length, 1);
  assert.ok(router[0].url.endsWith('/chat/completions'));
  const free = calls.filter(call => call.url.includes('api.free.ai'));
  assert.equal(free.length, 4); // two generations + two bounded public-file downloads
  assert.equal(free.filter(call => call.headers.Authorization).length, 2);
  assert.equal(calls.filter(call => call.url.endsWith('/sendPhoto')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/sendVoice')).length, 1);
  assert.equal(state.get('mediaUsage').image, 1);
  assert.equal(state.get('mediaUsage').voice, 1);
  assert.equal(budgetState.get('budget').image, 1);
  assert.equal(budgetState.get('budget').voice, 1);
  assert.equal(state.get('weather').alertsEnabled, true);
  assert.equal(state.get('followup').dueAt, undefined);
});

test('missing Free.ai key or voice for a custom model never reserves budget or falls back to OpenRouter', async () => {
  for (const missing of ['FREEAI_API_KEY', 'FREEAI_TTS_VOICE']) {
    const { env, calls, state, budgetState } = freeAIMediaSetup();
    delete env[missing];
    await createWorker().fetch(request(update(1, missing === 'FREEAI_API_KEY' ? '/image freeai snow' : '/voice سلام')), env);
    assert.equal(calls.filter(call => call.url.includes('openrouter') || call.url.includes('api.free.ai')).length, 0);
    assert.equal(state.has('mediaUsage'), false);
    assert.equal(budgetState.size, 0);
    assert.ok(calls.at(-1).body.text.includes(missing === 'FREEAI_API_KEY' ? 'FREEAI_API_KEY' : 'FREEAI_TTS_VOICE'));
  }
});

test('normal text still calls only OpenRouter, even when Free.ai key is absent', async () => {
  const { env, calls } = freeAIMediaSetup();
  delete env.FREEAI_API_KEY;
  await createWorker().fetch(request(update(1, 'حالم خوب نیست')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('api.free.ai')).length, 0);
});

test('Free.ai failure or unsafe returned asset retains budget claim and never retries another provider', async () => {
  const { env, calls, state } = freeAIMediaSetup();
  const original = env.fetchImpl;
  env.fetchImpl = async (url, options) => {
    if (url.endsWith('/v1/image/generate/')) {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({ image_url: 'http://127.0.0.1/secrets.png' });
    }
    return original(url, options);
  };
  const worker = createWorker();
  await worker.fetch(request(update(1, '/image freeai snow')), env);
  await worker.fetch(request(update(1, '/image freeai snow')), env);
  assert.equal(calls.filter(call => call.url.includes('api.free.ai')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('127.0.0.1') || call.url.includes('openrouter.ai')).length, 0);
  assert.equal(state.get('mediaUsage').image, 1);
  assert.ok(calls.at(-1).body.text.includes('مسیر مجاز'));
});

test('Free.ai permits five images per person, ten in total, and refreshes both quotas on the next UTC day', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const first = freeAIMediaSetup();
  const second = freeAIMediaSetup();
  const third = freeAIMediaSetup();
  second.env.MEDIA = first.env.MEDIA;
  third.env.MEDIA = first.env.MEDIA;
  second.env.TELEGRAM_ALLOWED_USER_IDS = '43';
  third.env.TELEGRAM_ALLOWED_USER_IDS = '44';
  const worker = createWorker();
  for (let i = 1; i <= 5; i++) {
    await worker.fetch(request(update(i, '/image freeai snow', 42)), first.env);
    await worker.fetch(request(update(100 + i, '/image freeai snow', 43)), second.env);
    now += 60_000;
  }
  assert.equal(first.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 5);
  assert.equal(second.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 5);
  assert.equal(first.state.get('mediaUsage').image, 5);
  assert.equal(second.state.get('mediaUsage').image, 5);
  assert.equal(first.budgetState.get('budget').image, 10);
  await worker.fetch(request(update(6, '/image freeai sixth', 42)), first.env);
  assert.ok(first.calls.at(-1).body.text.includes('پنج عکس'));
  assert.equal(first.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 5);
  await worker.fetch(request(update(200, '/image freeai eleventh', 44)), third.env);
  assert.ok(third.calls.at(-1).body.text.includes('ده عکس'));
  assert.equal(third.calls.filter(call => call.url.includes('api.free.ai')).length, 0);
  assert.equal(third.state.has('mediaUsage'), false);
  now = nextMediaDay(now);
  await worker.fetch(request(update(7, '/image freeai new day', 42)), first.env);
  assert.equal(first.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 6);
  assert.equal(first.state.get('mediaUsage').image, 1);
  assert.equal(first.budgetState.get('budget').image, 1);
});


test('voice works with just the Free.ai key using default Persian configuration, with default weather and no extra check-in timer', async () => {
  const { env, calls, state } = freeAIMediaSetup();
  delete env.FREEAI_TTS_MODEL;
  delete env.FREEAI_TTS_VOICE;
  await createWorker().fetch(request(update(1, '/voice سلام کن')), env);
  const speech = calls.find(call => call.url.endsWith('/v1/tts/'));
  assert.equal(speech.body.model, 'piper');
  assert.equal(speech.body.voice, 'fa_IR-amir-medium');
  assert.equal(speech.body.language, 'fa');
  assert.equal(calls.filter(call => call.url.endsWith('/sendVoice')).length, 1);
  assert.equal(state.get('mediaUsage').voice, 1);
  assert.equal(state.get('followup').dueAt, undefined);
  assert.equal(state.get('weather').alertsEnabled, true);
});

test('a rejected Free.ai voice shows only its safe diagnostic code and retains text, without retry or fallback', async () => {
  const { env, calls, state } = freeAIMediaSetup();
  const original = env.fetchImpl;
  env.fetchImpl = async (url, options) => {
    if (url.endsWith('/v1/tts/')) {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({ error: 'Unsupported language: private-transcript sk-free-secret' }, { status: 400 });
    }
    return original(url, options);
  };
  await createWorker().fetch(request(update(1, '/voice سلام')), env);
  assert.equal(calls.filter(call => call.url.endsWith('/v1/tts/')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/speech')).length, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/sendVoice')).length, 0);
  const messages = calls.filter(call => call.url.endsWith('/sendMessage')).map(call => call.body.text);
  assert.ok(messages.some(message => message.includes('یه قدم کوچیک')));
  assert.ok(messages.at(-1).includes('MEDIA_HTTP_400_LANGUAGE'));
  assert.ok(!messages.join(' ').includes('private-transcript'));
  assert.ok(!messages.join(' ').includes('sk-free-secret'));
  assert.equal(state.get('mediaUsage').voice, 1);
});

test('approved default split keeps images on Free.ai but sends voice only to OpenRouter, even with legacy provider=freeai', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, calls, state } = freeAIMediaSetup();
  delete env.MEDIA_VOICE_PROVIDER;
  env.MEDIA_PROVIDER = 'freeai';
  // A previously failing Free.ai voice selection must not affect the new route.
  env.FREEAI_TTS_MODEL = 'unsupported-old-model';
  env.FREEAI_TTS_VOICE = 'unsupported-old-voice';
  const original = env.fetchImpl;
  env.fetchImpl = async (url, options) => {
    if (url.includes('openrouter.ai')) assert.equal(options.headers.Authorization, 'Bearer test-key');
    return original(url, options);
  };
  const worker = createWorker();
  await worker.fetch(request(update(1, '/image freeai snow')), env);
  now += 60_000;
  await worker.fetch(request(update(2, '/voice سلام')), env);
  assert.equal(calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/api/v1/images')).length, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/speech')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/v1/tts/')).length, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/sendPhoto')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/sendVoice')).length, 1);
  assert.equal(state.get('mediaUsage').voice, 1);
  assert.equal(state.get('mediaUsage').image, 1);
  assert.equal(state.get('weather').alertsEnabled, true);
  assert.equal(state.get('followup').dueAt, undefined);
});

test('switching the voice provider does not clear spent attempts or require a Free.ai key for voice', async t => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, calls, state, budgetState } = freeAIMediaSetup();
  delete env.MEDIA_VOICE_PROVIDER;
  delete env.FREEAI_API_KEY;
  state.set('mediaUsage', { voice: 2, image: 2, lastAt: now - 60_000, expiresAt: nextMediaDay(now) });
  budgetState.set('budget', { voice: 2, image: 2, expiresAt: nextMediaDay(now) });
  const worker = createWorker();
  await worker.fetch(request(update(1, '/voice سلام')), env);
  await worker.fetch(request(update(2, '/voice دوباره سلام')), env);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/speech')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('api.free.ai')).length, 0);
  assert.equal(state.get('mediaUsage').voice, 3);
  assert.equal(state.get('mediaUsage').image, 2);
  assert.equal(budgetState.get('budget').voice, 3);
  assert.ok(calls.at(-1).body.text.includes('سهمیهٔ امروزت'));
});

test('OpenRouter voice rejection never retries or falls back to Free.ai', async () => {
  const { env, calls } = freeAIMediaSetup();
  delete env.MEDIA_VOICE_PROVIDER;
  env.failSpeech = true;
  await createWorker().fetch(request(update(1, '/voice سلام')), env);
  assert.equal(calls.filter(call => call.url.endsWith('/audio/speech')).length, 1);
  assert.equal(calls.filter(call => call.url.includes('api.free.ai')).length, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/sendVoice')).length, 0);
  assert.ok(calls.at(-1).body.text.includes('اعتبار'));
});

test('incompatible Gemini voice override is rejected before any chat charge or media budget reservation', async () => {
  const { env, calls, state, budgetState } = freeAIMediaSetup();
  delete env.MEDIA_VOICE_PROVIDER;
  env.OPENROUTER_SPEECH_MODEL = 'google/gemini-3.8-flash-lite-tts';
  env.OPENROUTER_VOICE = 'not-a-valid-gemini-voice';
  await createWorker().fetch(request(update(1, '/voice سلام')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai') || call.url.includes('api.free.ai')).length, 0);
  assert.equal(state.has('mediaUsage'), false);
  assert.equal(budgetState.size, 0);
  assert.ok(calls.at(-1).body.text.includes('سازگار نیست'));
});

test('چه خبر uses shared Iran news, one isolated rewrite and attributed links without touching media or prices', async () => {
  const { env, calls, state } = setup();
  state.set('session', { messages: [{ role: 'user', content: 'private-history-must-not-go-to-news' }], seen: [], lastAt: 0, introduced: true, expiresAt: Date.now() + 60_000 });
  let feedCalls = 0;
  env.MARKETS = { idFromName: name => { assert.equal(name, 'iran-news'); return name; }, get: () => ({ fetch: async url => {
    feedCalls++; assert.equal(url, 'https://market.internal/news');
    return Response.json({ items: [{ title: 'خبر آزمایشی ایران', description: 'شرح آزمایشی ایران', source: 'ایسنا', sourceId: 'isna', url: 'https://www.isna.ir/news/123/test', publishedAt: Date.now() - 60_000 }], fetchedAt: Date.now() });
  } }) };
  const original = env.fetchImpl;
  env.fetchImpl = async (url, options) => {
    if (url.includes('openrouter.ai')) {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({ choices: [{ message: { content: 'راستی، ایسنا یه خبر تازه درباره ایران نوشته.' } }] });
    }
    return original(url, options);
  };
  await createWorker().fetch(request(update(1, 'چه خبر؟')), env);
  assert.equal(feedCalls, 1);
  const model = calls.filter(call => call.url.includes('openrouter.ai'));
  assert.equal(model.length, 1);
  assert.ok(!JSON.stringify(model).includes('private-history-must-not-go-to-news'));
  const reply = calls.at(-1).body;
  assert.equal(reply.parse_mode, 'HTML');
  assert.ok(reply.text.includes('ایسنا یه خبر تازه'));
  assert.ok(reply.text.includes('https://www.isna.ir/news/123/test'));
  assert.deepEqual(reply.link_preview_options, { is_disabled: true });
  assert.equal(state.has('mediaUsage'), false);
  assert.equal(state.get('followup').dueAt, undefined);
  assert.ok(state.get('session').messages.length <= 30);
  await createWorker().fetch(request(update(1, 'چه خبر؟')), env);
  assert.equal(feedCalls, 1);
  await createWorker().fetch(request(update(2, '/news')), env);
  assert.equal(feedCalls, 1);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 1);
});

test('unavailable fresh news returns honest casual notice with no model charge or generic hallucinated answer', async () => {
  const { env, calls } = setup();
  env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ items: [] }, { status: 503 }) }) };
  await createWorker().fetch(request(update(1, 'اخبار ایران')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 0);
  assert.ok(calls.at(-1).body.text.includes('نمی‌خوام از خودم'));
});

test('rewrite billing error is actionable, does not replace news with headlines, and leaves conversation history intact', async () => {
  const { env, calls, state } = setup();
  const history = [{ role: 'user', content: 'private conversation' }, { role: 'assistant', content: 'previous answer' }];
  state.set('session', { messages: history, seen: [], lastAt: 0, introduced: true, expiresAt: Date.now() + 60_000 });
  env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ items: [{ title: 'raw headline must not be sent', description: 'source excerpt', source: 'ایسنا', sourceId: 'isna', url: 'https://www.isna.ir/news/123/test', publishedAt: Date.now() - 60_000 }] }) }) };
  const original = env.fetchImpl;
  env.fetchImpl = async (url, options) => {
    if (url.includes('openrouter.ai')) {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response('secret billing body key-token', { status: 402 });
    }
    return original(url, options);
  };
  const worker = createWorker();
  await worker.fetch(request(update(1, 'چه خبر؟')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 1);
  assert.ok(calls.at(-1).body.text.includes('NEWS_HTTP_402'));
  assert.ok(calls.at(-1).body.text.includes('OpenRouter'));
  assert.ok(!calls.at(-1).body.text.includes('raw headline'));
  assert.ok(!calls.at(-1).body.text.includes('secret billing'));
  assert.deepEqual(state.get('session').messages, history);
  await worker.fetch(request(update(1, 'چه خبر؟')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 1);
});

test('date questions use only the shared calendar, preserve bounded history and enroll default weather without consuming media/model budgets', async () => {
  const { env, calls, state } = setup(); let calendarCalls = 0;
  env.MARKETS = { idFromName: name => { assert.equal(name, 'iran-calendar'); return name; }, get: () => ({ fetch: async url => {
    calendarCalls++; assert.equal(url, 'https://market.internal/calendar');
    return new Response('امروز چهارشنبه‌ست، سیزدهم آبان ۱۴۰۵ 🌱\nروز دانش‌آموز');
  } }) };
  const worker = createWorker();
  await worker.fetch(request(update(1, 'امروز چندمه؟')), env);
  assert.equal(calendarCalls, 1); assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 0);
  assert.ok(calls.at(-1).body.text.includes('روز دانش‌آموز'));
  assert.equal(state.get('session').messages.at(-1).content, calls.at(-1).body.text);
  assert.ok(state.get('session').messages.length <= 30);
  assert.equal(state.has('mediaUsage'), false); assert.equal(state.get('followup').dueAt, undefined);
  await worker.fetch(request(update(1, 'امروز چندمه؟')), env);
  await worker.fetch(request(update(2, '/date')), env);
  assert.equal(calendarCalls, 1);
});

test('calendar source outage still returns a current Tehran date instead of asking the model to invent occasions', async () => {
  const { env, calls } = setup();
  env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => { throw new Error('private upstream error'); } }) };
  await createWorker().fetch(request(update(1, 'امروز چه مناسبتی داره؟')), env);
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 0);
  assert.ok(calls.at(-1).body.text.includes('به وقت ایران'));
  assert.ok(calls.at(-1).body.text.includes('حدس نمی‌زنم'));
  assert.ok(!calls.at(-1).body.text.includes('private upstream error'));
});

test('creator contact is answered locally without paid requests, shared feeds or media budget usage', async () => {
  for (const text of ['/creator', 'سازنده‌ات کیه؟', 'کی تورو ساخته؟', 'آیدی سازنده رو بده']) {
    const { env, calls, state } = setup();
    await createWorker().fetch(request(update(1, text)), env);
    assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 0);
    assert.ok(calls.some(c => c.body.text.includes('@LC_amir1')));
    assert.ok(calls.at(-1).body.text.includes('پیام زندهٔ سازنده نیست'));
    assert.ok(state.get('session').messages.length <= 30);
    assert.equal(state.has('mediaUsage'), false);
    assert.equal(state.has('followup'), false);
  }
});

test('about and help expose creator contact and command without changing the short start greeting', async () => {
  const { env, calls } = setup();
  const worker = createWorker();
  await worker.fetch(request(update(1, '/about')), env);
  assert.ok(calls.some(c => c.body.text.includes('@LC_amir1')));
  await worker.fetch(request(update(2, '/help')), env);
  assert.ok(calls.at(-1).body.text.includes('/creator'));
  assert.equal(calls.filter(call => call.url.includes('openrouter.ai')).length, 0);
});

function withMembership(options = {}) {
  const f = setup(); delete f.env.JOIN_REQUIRED;
  const original = f.env.fetchImpl;
  f.memberStatus = options.status || 'left'; f.adminStatus = options.admin || 'administrator';
  f.env.fetchImpl = async (url, requestOptions) => {
    const method = url.split('/').at(-1), body = JSON.parse(requestOptions.body);
    let result;
    if (['getMe', 'getChatMember', 'getWebhookInfo', 'setWebhook', 'answerCallbackQuery', 'editMessageReplyMarkup'].includes(method)) {
      f.calls.push({ url, body });
      if (method === 'getMe') result = { id: 900, is_bot: true };
      if (method === 'getChatMember') {
        if (options.error) return new Response('private-token-response', { status: 403 });
        assert.equal(body.chat_id, '@qhatel_roya');
        result = { user: { id: body.user_id }, status: body.user_id === 900 ? f.adminStatus : f.memberStatus };
      }
      if (method === 'getWebhookInfo') result = { url: 'https://example.workers.dev/webhook', allowed_updates: ['message'], max_connections: 1 };
      if (method === 'setWebhook') result = true;
      return Response.json({ ok: true, result });
    }
    return original(url, requestOptions);
  };
  return f;
}
function joinCallback(id = 2, user = 42) {
  return { update_id: id, callback_query: { id: `test-${id}`, from: { id: user }, data: 'membership:check:v1', message: { message_id: 10, from: { id: 900, is_bot: true }, chat: { id: user, type: 'private' } } } };
}

test('nonmembers cannot start, chat, use media, news, dates, prices, weather or enable paid outreach', async () => {
  for (const text of ['/start', 'سلام', '/image freeai منظره', '/voice سلام', '/news', '/date', '/prices', '/weather', '/test_snow', '/followup', '/alerts', '/creator bypass attempt']) {
    const { env, calls, state } = withMembership();
    await createWorker().fetch(request(update(1, text)), env);
    assert.ok(calls.every(c => c.url.includes('api.telegram.org')));
    const sent = calls.at(-1).body;
    assert.equal(sent.reply_markup.inline_keyboard[0][0].url, 'https://t.me/qhatel_roya');
    assert.equal(sent.reply_markup.inline_keyboard[1][0].callback_data, 'membership:check:v1');
    assert.equal(state.get('session').messages.length, 0);
    for (const key of ['followup', 'weather', 'snowPreview', 'mediaUsage']) assert.equal(state.has(key), false, key);
    assert.equal(calls.filter(c => c.url.endsWith('/setWebhook')).length, 1);
  }
});

test('only actual membership opens chat, and leaving immediately closes it again without a positive cache', async () => {
  const f = withMembership({ status: 'member' }); const worker = createWorker();
  await worker.fetch(request(update(1, 'سلام')), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  f.memberStatus = 'left';
  await worker.fetch(request(update(2, 'دوباره سلام')), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  assert.ok(f.calls.at(-1).body.reply_markup);
  assert.equal(f.state.get('session').messages.length, 2);
});

test('join callback is acknowledged, rechecks the clicking user and unlocks no paid request until a new message', async () => {
  const f = withMembership(); const worker = createWorker();
  await worker.fetch(request(joinCallback()), f.env);
  assert.ok(f.calls.some(c => c.url.endsWith('/answerCallbackQuery') && c.body.callback_query_id === 'test-2'));
  assert.ok(f.calls.at(-1).body.reply_markup);
  f.memberStatus = 'member';
  await worker.fetch(request(joinCallback(3)), f.env);
  assert.ok(f.calls.at(-1).body.text.includes('عضویتت تأیید شد'));
  assert.ok(f.calls.some(c => c.url.endsWith('/editMessageReplyMarkup') && c.body.message_id === 10));
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
  assert.equal(f.state.get('session').messages.length, 0);
  assert.equal(f.state.get('followup').dueAt, undefined)
  assert.equal(f.state.get('weather').alertsEnabled, true);
  const length = f.calls.length;
  await worker.fetch(request(joinCallback(3)), f.env); assert.equal(f.calls.length, length);
  await worker.fetch(request(update(4, 'سلام')), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
});

test('forged, unrelated, group and cross-user callbacks cannot reach any API', async () => {
  const f = withMembership(); const worker = createWorker();
  const wrongData = joinCallback(); wrongData.callback_query.data = 'membership:check:other';
  const wrongChat = joinCallback(); wrongChat.callback_query.message.chat.id = 99;
  const group = joinCallback(); group.callback_query.message.chat.type = 'group';
  const bot = joinCallback(); bot.callback_query.from.is_bot = true;
  const inline = joinCallback(); delete inline.callback_query.message;
  const mixed = { ...joinCallback(), message: update().message };
  for (const body of [wrongData, wrongChat, group, bot, inline, mixed, joinCallback(9, 99)]) await worker.fetch(request(body), f.env);
  assert.equal((await worker.fetch(request(joinCallback(), 'bad-secret'), f.env)).status, 403);
  assert.equal(f.calls.length, 0); assert.equal(f.state.size, 0);
});

test('Telegram errors or missing admin rights never unlock chat or expose upstream errors', async () => {
  for (const options of [{ admin: 'member', status: 'member' }, { error: true, status: 'member' }]) {
    const f = withMembership(options);
    await createWorker().fetch(request(update(1, 'سلام')), f.env);
    assert.ok(f.calls.at(-1).body.text.includes('فعلاً چت باز نمی‌شه'));
    assert.ok(!f.calls.at(-1).body.text.includes('private-token-response'));
    assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
  }
});

test('privacy, creator contact, deletion and opt-outs remain available without membership', async () => {
  for (const text of ['/privacy', '/about', '/help', '/creator', 'سازنده کیه؟', '/reset', '/stop', '/weatherstop', '/forgetcity']) {
    const f = withMembership(); await createWorker().fetch(request(update(1, text)), f.env);
    assert.equal(f.calls.filter(c => c.url.endsWith('/getChatMember')).length, 0);
    assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
    assert.ok(f.calls.some(c => c.url.endsWith('/sendMessage')));
  }
});

test('nonmember alarms do not send check-ins or incur weather/model costs, while preserving opt-out preferences', async () => {
  const f = withMembership();
  f.state.set('followup', { chatId: 42, dueAt: Date.now() - 1000, noticeShown: true, disabled: false });
  f.state.set('weather', { chatId: 42, alertsEnabled: true, nextCheckAt: Date.now() - 1000, city: { name: 'آباده', latitude: 31.16, longitude: 52.65 } });
  await f.session.alarm();
  assert.equal(f.state.get('followup').dueAt, null);
  assert.ok(f.state.get('weather').nextCheckAt > Date.now());
  assert.equal(f.state.has('weatherOptOut'), false);
  assert.equal(f.calls.filter(c => c.url.includes('sendMessage') || c.url.includes('openrouter.ai') || c.url.includes('open-meteo')).length, 0);
});

async function withInstagram() {
  const { InstagramFeedHandler } = await import('./instagram.mjs');
  const f = setup(); const publicState = new Map(); const original = f.env.fetchImpl;
  f.videoURL = 'https://instagram.ftia13-1.fna.fbcdn.net/video.mp4?sig=test';
  f.env.fetchImpl = async (url, options) => {
    if (url.includes('vxinstagram.com')) {
      f.calls.push({ url, body: null });
      return new Response(`<video><source src="${f.videoURL}" type="video/mp4"></video>`, { headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('.fbcdn.net')) {
      f.calls.push({ url, body: null });
      return new Response(new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]), { headers: { 'Content-Type': 'video/mp4' } });
    }
    if (url.includes('songfinder.dev')) {
      f.calls.push({ url, body: Object.fromEntries(options.body.entries()) });
      return Response.json({ code: 0, data: { matched: true, title: 'Fixture song', artist: 'Fixture artist', spotifyUrl: 'https://open.spotify.com/track/123' } });
    }
    if (url.endsWith('/sendVideo')) {
      const body = options.body; f.lastToken = JSON.parse(body.get('reply_markup')).inline_keyboard[0][0].callback_data;
      f.calls.push({ url, body: { caption: body.get('caption'), markup: JSON.parse(body.get('reply_markup')), file: body.get('video') } });
      return Response.json({ ok: true, result: { message_id: 777, video: { file_id: 'fixture-video' } } });
    }
    if (url.endsWith('/getWebhookInfo')) return Response.json({ ok: true, result: { url: 'https://example.workers.dev/webhook', allowed_updates: ['message', 'callback_query'] } });
    return original(url, options);
  };
  const feed = new InstagramFeedHandler({ storage: { get: async k => structuredClone(publicState.get(k)), put: async (k, v) => publicState.set(k, structuredClone(v)) } }, f.env);
  f.env.MARKETS = { idFromName: name => { assert.equal(name, 'instagram-free'); return name; }, get: () => ({ fetch: (url, options) => feed.fetch(new Request(url, options)) }) };
  f.callback = (id = 2) => { const body = joinCallback(id); body.callback_query.data = f.lastToken; body.callback_query.message.message_id = 777; return body; };
  return f;
}

test('Instagram public link uploads actual video with music button, stripping tracking, and does not consume model/media credits while enrolling default weather', async () => {
  const f = await withInstagram();
  await createWorker().fetch(request(update(1, 'https://www.instagram.com/reel/DfUr8XJoNJC/?exln=secret-tracking')), f.env);
  const sent = f.calls.find(c => c.url.endsWith('/sendVideo'));
  assert.ok(sent.body.file instanceof Blob); assert.ok(sent.body.markup.inline_keyboard[0][0].callback_data.startsWith('igmusic:'));
  assert.ok(!sent.body.caption.includes('secret-tracking'));
  assert.equal(f.calls.filter(c => c.url.includes('songfinder') || c.url.includes('openrouter')).length, 0);
  assert.equal(f.state.get('instagramUsage').video, 1);
  assert.equal(f.state.has('mediaUsage'), false);
  assert.equal(f.state.get('followup').dueAt, undefined);
  assert.equal(f.state.get('weather').alertsEnabled, true);
  assert.equal(f.state.get('session').instagramJobs[0].messageId, 777);
  assert.equal(f.state.get('session').messages.length, 0);
});

test('music callback recognizes only a stored video for its own chat/message and replays cause no duplicate recognition', async () => {
  const f = await withInstagram(); const worker = createWorker();
  await worker.fetch(request(update(1, 'https://www.instagram.com/reel/DfUr8XJoNJC/')), f.env);
  await worker.fetch(request(f.callback()), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('songfinder')).length, 1);
  assert.ok(f.calls.at(-1).body.text.includes('Fixture song'));
  assert.ok(f.calls.at(-1).body.text.includes('https://open.spotify.com/track/123'));
  const length = f.calls.length; await worker.fetch(request(f.callback()), f.env); assert.equal(f.calls.length, length);
  await worker.fetch(request(f.callback(3)), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('songfinder')).length, 1);
  assert.ok(f.calls.at(-1).body.text.includes('نتیجهٔ تلاش قبلی'));
  assert.equal(f.calls.filter(c => c.url.includes('openrouter')).length, 0);
  assert.equal(f.state.get('instagramUsage').music, 1);
});

test('unknown, wrong-message, cross-chat and expired music buttons cannot request music recognition', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await withInstagram(); const worker = createWorker();
  await worker.fetch(request(update(1, 'https://www.instagram.com/reel/DfUr8XJoNJC/')), f.env);
  const wrong = f.callback(2); wrong.callback_query.message.message_id = 888;
  await worker.fetch(request(wrong), f.env);
  assert.ok(f.calls.at(-1).body.text.includes('منقضی یا نامعتبر'));
  const unknown = f.callback(3); unknown.callback_query.data = 'igmusic:' + 'f'.repeat(32); await worker.fetch(request(unknown), f.env);
  const cross = f.callback(4); cross.callback_query.from.id = 99; await worker.fetch(request(cross), f.env);
  now += 31 * 60000; await worker.fetch(request(f.callback(5)), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('songfinder')).length, 0);
});

test('Instagram quota survives reset and partial failures; quota cleanup remains scheduled without retaining video files', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await withInstagram(); const worker = createWorker();
  for (let i = 1; i <= 5; i++) { now += 11000; await worker.fetch(request(update(i, 'https://www.instagram.com/reel/DfUr8XJoNJC/')), f.env); }
  assert.equal(f.state.get('instagramUsage').video, 5);
  await worker.fetch(request(update(6, '/reset')), f.env);
  assert.deepEqual(f.state.get('session').instagramJobs, []);
  assert.equal(f.state.get('instagramUsage').video, 5);
  now += 11000; await worker.fetch(request(update(7, 'https://www.instagram.com/reel/DfUr8XJoNJC/')), f.env);
  assert.ok(f.calls.at(-1).body.text.includes('سقف رایگان'));
  assert.equal(f.calls.filter(c => c.url.endsWith('/sendVideo')).length, 5);
  assert.ok(f.alarmAt() > now);
  now = f.state.get('instagramUsage').expiresAt + 1; await f.session.alarm();
  assert.equal(f.state.has('instagramUsage'), false);
});

test('Instagram links and music callbacks remain subject to channel membership, including leaving after download', async () => {
  const f = withMembership();
  await createWorker().fetch(request(update(1, 'https://www.instagram.com/reel/DfUr8XJoNJC/')), f.env);
  assert.ok(f.calls.at(-1).body.reply_markup.inline_keyboard[0][0].url.includes('qhatel_roya'));
  const callback = joinCallback(2); callback.callback_query.data = 'igmusic:' + 'a'.repeat(32);
  await createWorker().fetch(request(callback), f.env);
  assert.ok(f.calls.at(-1).body.reply_markup.inline_keyboard[0][0].url.includes('qhatel_roya'));
  assert.ok(f.calls.every(c => c.url.includes('api.telegram.org')));
});

test('expired Instagram callback URLs are purged by an alarm even while the normal chat session is still active', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await withInstagram();
  f.state.set('weatherOptOut', true); // Isolate expiring callback metadata.
  await createWorker().fetch(request(update(1, 'https://www.instagram.com/reel/DfUr8XJoNJC/')), f.env);
  const record = f.state.get('session'), end = record.instagramJobs[0].expiresAt;
  record.expiresAt = end + 60000; f.state.set('session', record);
  await f.session.scheduleAlarm(); assert.equal(f.alarmAt(), end);
  now = end + 1; await f.session.alarm();
  assert.deepEqual(f.state.get('session').instagramJobs, []);
  assert.equal(f.alarmAt(), end + 60000);
});

test('Instagram failures consume only the independent attempt budget and hide private upstream errors', async () => {
  const f = await withInstagram();
  f.env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => { throw new Error('private-token-source-error'); } }) };
  await createWorker().fetch(request(update(1, 'https://www.instagram.com/reel/DfUr8XJoNJC/')), f.env);
  assert.equal(f.state.get('instagramUsage').video, 1);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter') || c.url.endsWith('/sendVideo')).length, 0);
  assert.ok(!f.calls.at(-1).body.text.includes('private-token'));
  assert.equal(f.state.has('mediaUsage'), false);
});

async function enableAsync(f) {
  const { CapacityHandler } = await import('./load-control.mjs');
  delete f.env.BOT_ASYNC_UPDATES;
  const state = new Map();
  const capacity = new CapacityHandler({ storage: { get: async k => structuredClone(state.get(k)), put: async (k, v) => state.set(k, structuredClone(v)) } });
  f.capacityState = state;
  f.env.MARKETS = { idFromName: name => { assert.equal(name, 'bot-capacity'); return name; }, get: () => ({ fetch: (url, options) => capacity.fetch(new Request(url, options)) }) };
  return f;
}

test('default webhook acknowledges a durable admission before any model call and processes later via alarm', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); const worker = createWorker();
  assert.equal((await worker.fetch(request(update(1, 'سلام')), f.env)).status, 200);
  assert.equal(f.calls.length, 0); assert.equal(f.state.get('inbox').pending.length, 1);
  assert.equal(f.state.has('session'), false);
  now += 200; await f.session.alarm();
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  assert.equal(f.state.get('inbox').pending.length, 0); assert.equal(f.state.get('inbox').active, null);
  assert.equal(f.capacityState.get('workTickets').length, 0);
  await worker.fetch(request(update(1, 'سلام')), f.env);
  assert.equal(f.state.get('inbox').pending.length, 0);
});

test('new ingress remains responsive while an earlier model call is waiting, with no concurrent same-chat history writes', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); const worker = createWorker(); const original = f.env.fetchImpl;
  let started, release;
  const modelStarted = new Promise(resolve => { started = resolve; });
  const modelGate = new Promise(resolve => { release = resolve; });
  f.env.fetchImpl = async (url, options) => { if (url.includes('openrouter.ai')) { started(); await modelGate; } return original(url, options); };
  await worker.fetch(request(update(1, 'پیام اول')), f.env);
  now += 200; const processing = f.session.alarm(); await modelStarted;
  assert.equal((await worker.fetch(request(update(2, 'پیام دوم')), f.env)).status, 200);
  assert.equal(f.state.get('inbox').pending.length, 1);
  assert.equal(f.state.get('inbox').active.update.update_id, 1);
  release(); await processing;
  assert.equal(f.state.get('session').messages.length, 2);
  now += 5000; await f.session.alarm();
  const calls = f.calls.filter(c => c.url.includes('openrouter.ai'));
  assert.equal(calls.length, 2); assert.equal(calls[1].body.messages.at(-1).content, 'پیام دوم');
  assert.ok(calls[1].body.messages.some(m => m.content === 'پیام اول'));
});

test('pending updates survive ChatSession recreation and revoked allowlist entries are not processed', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); await createWorker().fetch(request(update(1, 'سلام')), f.env);
  const recreated = new ChatSession({ storage: f.storage }, f.env);
  now += 200; await recreated.alarm();
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  await createWorker().fetch(request(update(2, 'لغوشده')), f.env);
  f.env.TELEGRAM_ALLOWED_USER_IDS = '99'; now += 5000; await recreated.alarm();
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  assert.equal(f.state.get('inbox').pending.length, 0);
});

test('full queues return an explicit bounded busy notice, reset cancels pending text and releases admission tickets', async () => {
  const f = await enableAsync(setup()); const worker = createWorker();
  await Promise.all(Array.from({ length: 12 }, (_, i) => worker.fetch(request(update(i + 1, 'queued-' + i)), f.env)));
  assert.equal(f.state.get('inbox').pending.length, 5);
  assert.equal(f.calls.filter(c => c.url.endsWith('/sendMessage')).length, 1);
  assert.ok(f.calls.at(-1).body.text.includes('پذیرفته نشد'));
  await worker.fetch(request(update(13, '/reset')), f.env);
  assert.equal(f.state.get('inbox').pending.length, 1);
  assert.equal(f.state.get('inbox').pending[0].update.message.text, '/reset');
  assert.equal(f.capacityState.get('workTickets').length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
});

test('expired queue entries are removed with an honest notice instead of late paid generation', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); await createWorker().fetch(request(update(1, 'سلام')), f.env);
  now += 11 * 60000; await f.session.alarm();
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
  assert.ok(f.calls.at(-1).body.text.includes('پردازش نشد'));
  assert.equal(f.state.get('inbox').pending.length, 0);
});

test('crash recovery never repeats a provider call already reserved in persistent session history', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); await createWorker().fetch(request(update(1, 'سلام')), f.env);
  now += 200; await f.session.inbox.claim('u1');
  f.state.set('session', { seen: [1], messages: [], expiresAt: now + 1800000, lastAt: now, introduced: true });
  now += 4 * 60000 + 1;
  await new ChatSession({ storage: f.storage }, f.env).alarm();
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
  assert.equal(f.state.get('inbox').active, null);
});

test('capacity outages leave work durably queued with backoff; an admission outage is retriable rather than falsely acknowledged', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); const worker = createWorker();
  const original = f.env.MARKETS.get;
  f.env.MARKETS.get = () => ({ fetch: async () => { throw new Error('private-error'); } });
  assert.equal((await worker.fetch(request(update(1)), f.env)).status, 503);
  assert.equal(f.state.get('inbox'), undefined); assert.equal(f.calls.length, 0);
  f.env.MARKETS.get = original;
  assert.equal((await worker.fetch(request(update(1)), f.env)).status, 200);
  f.env.MARKETS.get = () => ({ fetch: async () => { throw new Error('private-error'); } });
  now += 200; await f.session.alarm();
  assert.equal(f.state.get('inbox').pending.length, 1); assert.ok(f.alarmAt() > now);
  assert.equal(f.calls.length, 0);
  f.env.MARKETS.get = original; now += 31000; await f.session.alarm();
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
});

test('a transient reservation-write failure recovers its durable active job without losing admission or repeating generation', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); await createWorker().fetch(request(update(1)), f.env);
  const put = f.storage.put; let failOnce = true;
  f.storage.put = async (key, value) => { if (key === 'session' && failOnce) { failOnce = false; throw new Error('storage temporarily unavailable'); } return put(key, value); };
  now += 200; await f.session.alarm();
  assert.equal(f.calls.length, 0); assert.equal(f.state.get('inbox').active.id, 'u1');
  assert.equal(f.capacityState.get('workTickets').length, 1);
  now += 6000; await f.session.alarm();
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
  assert.equal(f.state.get('inbox').active, null);
});

test('quota cleanup deadlines cannot overwrite an earlier durable inbox alarm', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); await createWorker().fetch(request(update(1)), f.env);
  await f.session.reserveInstagram('video');
  assert.equal(f.alarmAt(), now + 100); assert.equal(f.state.get('instagramUsage').video, 1);
});

test('automatic weather respects the same four work leases and backs off without consuming a model call', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup());
  for (let i = 1; i <= 4; i++) { await f.session.capacity({ op: 'admit', id: 'u' + i }); await f.session.capacity({ op: 'start', id: 'u' + i }); }
  f.state.set('weather', { alertsEnabled: true, nextCheckAt: now - 1, chatId: 42, city: { name: 'آباده' } });
  await f.session.alarm();
  assert.equal(f.calls.length, 0); assert.ok(f.state.get('weather').nextCheckAt >= now + 60000);
  assert.equal(f.state.get('weather').alertsEnabled, true); assert.equal(f.capacityState.get('workTickets').length, 4);
});

test('switching to legacy ingress does not strand already accepted durable jobs in an alarm loop', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await enableAsync(setup()); await createWorker().fetch(request(update(1)), f.env);
  f.env.BOT_ASYNC_UPDATES = 'false'; now += 200; await f.session.alarm();
  assert.equal(f.state.get('inbox').pending.length, 0);
  assert.equal(f.calls.filter(c => c.url.includes('openrouter.ai')).length, 1);
});

test('a first feature-only interaction automatically enrolls weather without requiring alerts or arming check-ins', async () => {
  const f = setup(); f.env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => new Response('تاریخ معتبر') }) };
  const worker = createWorker(); await worker.fetch(request(update(1, '/date')), f.env);
  assert.equal(f.state.get('weather').alertsEnabled, true); assert.equal(f.state.get('weather').chatId, 42);
  assert.equal(f.state.get('weather').city.name, 'آباده، استان فارس');
  assert.equal(f.state.get('followup').noticeShown, true); assert.equal(f.state.get('followup').dueAt, undefined);
  assert.equal(f.calls.filter(c => c.body.text === FOLLOWUP_NOTICE).length, 1);
  await worker.fetch(request(update(2, '/start')), f.env);
  assert.equal(f.calls.filter(c => c.body.text === FOLLOWUP_NOTICE).length, 1);
  assert.ok(f.state.get('followup').dueAt > Date.now());
});

test('a known previously notified chat migrates inactive weather on its existing alarm, without a new command or repeated notice', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = setup();
  f.state.set('followup', { chatId: 42, noticeShown: true, disabled: false, dueAt: now + FOLLOWUP_DELAY });
  f.state.set('weather', { chatId: 42, city: { name: 'شیراز', latitude: 29.59, longitude: 52.58 }, alertsEnabled: false, nextCheckAt: null });
  await f.session.alarm();
  assert.equal(f.state.get('weather').alertsEnabled, true); assert.equal(f.state.get('weather').nextCheckAt, now + 1000);
  assert.equal(f.state.get('weather').city.name, 'شیراز'); assert.equal(f.calls.length, 0); assert.equal(f.alarmAt(), now + 1000);
});

test('lazy background migration does not resurrect cancellations, contact unauthorized users or send cold disclosures', async () => {
  for (const reason of ['weatherstop', 'globalstop', 'revoked', 'undisclosed']) {
    const f = setup();
    f.state.set('followup', { chatId: 42, noticeShown: reason !== 'undisclosed', disabled: reason === 'globalstop' });
    f.state.set('weather', { chatId: 42, city: { name: 'custom', latitude: 20, longitude: 30 }, alertsEnabled: false, nextCheckAt: null });
    if (reason === 'weatherstop') f.state.set('weatherOptOut', true);
    if (reason === 'revoked') f.env.TELEGRAM_ALLOWED_USER_IDS = '99';
    await f.session.alarm(); assert.equal(f.state.get('weather').alertsEnabled, false); assert.equal(f.calls.length, 0);
  }
});

test('failed generic disclosure prevents feature-only enrollment before any generation or external data call', async () => {
  const f = setup(); let feeds = 0;
  f.env.MARKETS = { idFromName: name => name, get: () => ({ fetch: async () => { feeds++; return new Response('data'); } }) };
  f.env.fetchImpl = async () => { throw new Error('private delivery problem'); };
  await createWorker().fetch(request(update(1, '/date')), f.env);
  assert.equal(f.state.has('weather'), false); assert.equal(f.state.has('followup'), false); assert.equal(feeds, 0);
});

function dualImageSetup() {
  const rig = freeAIMediaSetup();
  rig.env.MEDIA_VOICE_PROVIDER = 'openrouter';
  rig.env.LAOZHANG_API_KEY = 'private-lao-key'; rig.env.LAOZHANG_IMAGE_MODEL = 'fixture-model';
  let messageId = 900;
  const original = rig.env.fetchImpl;
  rig.env.fetchImpl = async (url, options) => {
    if (url === 'https://api2.laozhang.ai/v1/images/generations' || url.startsWith('https://api.laozhang.ai/v1beta/models/')) {
      rig.calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      assert.equal(options.headers.Authorization, 'Bearer private-lao-key');
      return rig.env.failLao ? new Response('private upstream secret', { status: 402 }) : Response.json(url.includes('/v1beta/')
        ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoA' } }] } }] }
        : { data: [{ b64_json: 'iVBORw0KGgoA' }] });
    }
    const response = await original(url, options);
    if (url.endsWith('/sendMessage') && JSON.parse(options.body).reply_markup) return Response.json({ ok: true, result: { message_id: ++messageId } });
    return response;
  };
  return rig;
}
function imageCallback(id, choice, provider = 'freeai', user = 42) {
  return { update_id: id, callback_query: { id: 'image-' + id, data: `imgpick:${choice.token}:${provider}`, from: { id: user }, message: { message_id: choice.messageId, chat: { id: user, type: 'private' } } } };
}

test('an image request asks for provider without spending quota, then consumes both buttons at most once', async () => {
  const f = dualImageSetup(), worker = createWorker();
  await worker.fetch(request(update(1, 'برام یه عکس کلبه برفی بساز')), f.env);
  assert.equal(f.state.has('mediaUsage'), false); assert.equal(f.budgetState.size, 0);
  assert.equal(f.calls.filter(c => /free.ai|laozhang.ai|openrouter.ai/.test(c.url)).length, 0);
  const choice = f.state.get('session').imageChoice;
  assert.equal(choice.prompt, 'کلبه برفی'); assert.deepEqual(f.state.get('session').messages, []);
  const keyboard = f.calls.find(c => c.body.reply_markup)?.body.reply_markup.inline_keyboard[0];
  assert.equal(keyboard.length, 2); assert.ok(keyboard[1].text.includes('اعتباری'));
  await worker.fetch(request(imageCallback(2, choice)), f.env);
  await worker.fetch(request(imageCallback(2, choice)), f.env);
  await worker.fetch(request(imageCallback(3, choice, 'laozhang')), f.env);
  assert.equal(f.calls.filter(c => c.url.endsWith('/sendPhoto')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('laozhang.ai')).length, 0);
  assert.equal(f.state.get('mediaUsage').image, 1); assert.equal(f.budgetState.get('budget').image, 1);
  assert.equal(f.state.get('session').imageChoice, undefined);
});

test('LaoZhang selection is request-specific, needs no Free.ai key and never changes the voice provider', async () => {
  const f = dualImageSetup(), worker = createWorker(); delete f.env.FREEAI_API_KEY;
  await worker.fetch(request(update(1, '/image یه کلبه')), f.env);
  await worker.fetch(request(imageCallback(2, f.state.get('session').imageChoice, 'laozhang')), f.env);
  assert.equal(f.state.has('mediaUsage'), false);
  await worker.fetch(request(imageCallback(3, f.state.get('session').imageChoice, 'g31')), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('laozhang.ai')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('free.ai') || c.url.includes('openrouter.ai')).length, 0);
  assert.equal(f.calls.filter(c => c.url.endsWith('/sendPhoto')).length, 1);
  assert.equal(f.env.MEDIA_IMAGE_PROVIDER, undefined); assert.equal(f.env.MEDIA_VOICE_PROVIDER, 'openrouter');
  assert.equal(f.state.get('mediaUsage').image, 1);
});

test('missing LaoZhang secret consumes neither personal nor global budget and never falls back', async () => {
  for (const missing of ['LAOZHANG_API_KEY']) {
    const f = dualImageSetup(), worker = createWorker(); delete f.env[missing];
    await worker.fetch(request(update(1, '/image cabin')), f.env);
    await worker.fetch(request(imageCallback(2, f.state.get('session').imageChoice, 'laozhang')), f.env);
    await worker.fetch(request(imageCallback(3, f.state.get('session').imageChoice, 'g31')), f.env);
    assert.equal(f.state.has('mediaUsage'), false); assert.equal(f.budgetState.size, 0);
    assert.equal(f.calls.filter(c => /free.ai|laozhang.ai|openrouter.ai/.test(c.url)).length, 0);
    assert.ok(f.calls.at(-1).body.text.includes(missing));
  }
});

test('expired, forged, cross-user or wrong-message image choices cannot trigger generation', async t => {
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const f = dualImageSetup(), worker = createWorker(); f.env.TELEGRAM_ALLOWED_USER_IDS = '*';
  await worker.fetch(request(update(1, '/image cabin')), f.env);
  const choice = f.state.get('session').imageChoice;
  await worker.fetch(request(imageCallback(2, { ...choice, token: 'a'.repeat(32) })), f.env);
  await worker.fetch(request(imageCallback(3, { ...choice, messageId: choice.messageId + 1 })), f.env);
  await worker.fetch(request(imageCallback(4, choice, 'freeai', 43)), f.env);
  now += 10 * 60_000 + 1;
  await worker.fetch(request(imageCallback(5, choice)), f.env);
  assert.equal(f.state.has('mediaUsage'), false); assert.equal(f.budgetState.size, 0);
  assert.equal(f.calls.filter(c => /free.ai|laozhang.ai|openrouter.ai/.test(c.url)).length, 0);
});

test('both image providers share the same cooldown and five-attempt daily limit across reset', async t => {
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const f = dualImageSetup(), worker = createWorker();
  await worker.fetch(request(update(1, '/image freeai cabin')), f.env);
  await worker.fetch(request(update(2, '/image laozhang cabin')), f.env);
  assert.equal(f.state.get('mediaUsage').image, 1); assert.ok(f.calls.at(-1).body.text.includes('یک دقیقه'));
  for (let i = 0; i < 4; i++) {
    now += 60_000; await worker.fetch(request(update(3 + i, '/image ' + (i % 2 ? 'freeai' : 'laozhang') + ' cabin')), f.env);
  }
  await worker.fetch(request(update(7, '/reset')), f.env);
  now += 60_000; await worker.fetch(request(update(8, '/image laozhang cabin')), f.env);
  assert.equal(f.state.get('mediaUsage').image, 5); assert.equal(f.budgetState.get('budget').image, 5);
  assert.equal(f.calls.filter(c => c.url.includes('laozhang.ai')).length, 2);
  assert.equal(f.calls.filter(c => c.url.endsWith('/v1/image/generate/')).length, 3);
  assert.ok(f.calls.at(-1).body.text.includes('سهمیهٔ امروزت'));
});

test('an exhausted LaoZhang call keeps its quota claim without fallback, duplicated clicks or secret leakage', async () => {
  const f = dualImageSetup(), worker = createWorker(); f.env.failLao = true;
  await worker.fetch(request(update(1, '/image cabin')), f.env);
  const choice = f.state.get('session').imageChoice;
  await worker.fetch(request(imageCallback(2, choice, 'laozhang')), f.env);
  const models = f.state.get('session').imageChoice;
  await worker.fetch(request(imageCallback(3, models, 'g31')), f.env);
  await worker.fetch(request(imageCallback(4, models, 'g25')), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('laozhang.ai')).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('free.ai') || c.url.includes('openrouter.ai') || c.url.endsWith('/sendPhoto')).length, 0);
  assert.equal(f.state.get('mediaUsage').image, 1);
  assert.ok(f.calls.some(c => c.body.text?.includes('اعتبار')));
  assert.ok(!JSON.stringify(f.calls.filter(c => c.url.endsWith('/sendMessage'))).includes('private upstream secret'));
});

test('reset, start and replacement requests invalidate old choices; alarms remove expired pending prompts', async t => {
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const f = dualImageSetup(), worker = createWorker(); f.state.set('weatherOptOut', true);
  await worker.fetch(request(update(1, '/image first')), f.env); const first = f.state.get('session').imageChoice;
  await worker.fetch(request(update(2, '/image second')), f.env); const second = f.state.get('session').imageChoice;
  assert.notEqual(first.token, second.token);
  await worker.fetch(request(imageCallback(3, first)), f.env);
  assert.equal(f.state.get('session').imageChoice.token, second.token);
  now += 10 * 60_000; await f.session.alarm();
  assert.equal(f.state.get('session').imageChoice, undefined); assert.equal(f.state.has('mediaUsage'), false);
  await worker.fetch(request(update(4, '/image third')), f.env);
  await worker.fetch(request(update(5, '/reset')), f.env); assert.equal(f.state.get('session').imageChoice, undefined);
  await worker.fetch(request(update(6, '/image fourth')), f.env);
  await worker.fetch(request(update(7, '/start')), f.env); assert.equal(f.state.get('session').imageChoice, undefined);
});

test('choosing an image provider still requires current membership before any media quota or API call', async () => {
  const f = dualImageSetup(), worker = createWorker();
  await worker.fetch(request(update(1, '/image cabin')), f.env);
  const choice = f.state.get('session').imageChoice;
  f.env.JOIN_REQUIRED = 'true';
  f.session.membership.check = async () => 'left';
  await worker.fetch(request(imageCallback(2, choice, 'laozhang')), f.env);
  assert.equal(f.state.has('mediaUsage'), false); assert.equal(f.budgetState.size, 0);
  assert.equal(f.calls.filter(c => /free.ai|laozhang.ai|openrouter.ai/.test(c.url)).length, 0);
});

test('a direct explicit image request invalidates any previous pending choice', async () => {
  const f = dualImageSetup(), worker = createWorker();
  await worker.fetch(request(update(1, '/image first')), f.env); const choice = f.state.get('session').imageChoice;
  await worker.fetch(request(update(2, '/image freeai second')), f.env);
  assert.equal(f.state.get('session').imageChoice, undefined);
  await worker.fetch(request(imageCallback(3, choice, 'laozhang')), f.env);
  assert.equal(f.calls.filter(c => c.url.includes('laozhang.ai')).length, 0);
  assert.equal(f.calls.filter(c => c.url.endsWith('/sendPhoto')).length, 1);
});

test('ten global image attempts are shared across providers and isolated chat sessions', async t => {
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const a = dualImageSetup(), b = dualImageSetup(), c = dualImageSetup(), worker = createWorker();
  b.env.TELEGRAM_ALLOWED_USER_IDS = '43'; c.env.TELEGRAM_ALLOWED_USER_IDS = '44';
  b.env.MEDIA = a.env.MEDIA; c.env.MEDIA = a.env.MEDIA;
  for (let i = 0; i < 5; i++) {
    await worker.fetch(request(update(i + 1, '/image freeai cabin')), a.env);
    await worker.fetch(request(update(i + 1, '/image laozhang cabin', 43)), b.env);
    now += 60_000;
  }
  await worker.fetch(request(update(1, '/image laozhang cabin', 44)), c.env);
  assert.equal(a.budgetState.get('budget').image, 10);
  assert.equal(a.state.get('mediaUsage').image, 5); assert.equal(b.state.get('mediaUsage').image, 5);
  assert.equal(c.state.has('mediaUsage'), false);
  assert.equal(c.calls.filter(call => call.url.includes('laozhang.ai')).length, 0);
  assert.ok(c.calls.at(-1).body.text.includes('کل ربات'));
});

test('LaoZhang offers every documented Gemini image model before charging, without a configured default', async () => {
  const f = dualImageSetup(), worker = createWorker(); delete f.env.LAOZHANG_IMAGE_MODEL;
  await worker.fetch(request(update(1, '/image کلبه')), f.env);
  const providers = f.state.get('session').imageChoice;
  // A forged model button cannot skip the provider stage.
  await worker.fetch(request(imageCallback(2, providers, 'gpro')), f.env);
  assert.equal(f.state.get('session').imageChoice.token, providers.token);
  await worker.fetch(request(imageCallback(3, providers, 'laozhang')), f.env);
  const models = f.state.get('session').imageChoice;
  assert.equal(models.stage, 'model'); assert.notEqual(models.token, providers.token);
  assert.equal(models.expiresAt, providers.expiresAt); // Stage change never extends prompt retention.
  const keyboard = f.calls.filter(c => c.body.reply_markup?.inline_keyboard?.length === 5).at(-1).body.reply_markup.inline_keyboard;
  assert.equal(keyboard.flat().length, 5);
  assert.equal(new Set(keyboard.flat().map(button => button.callback_data.split(':')[2])).size, 5);
  assert.equal(f.state.has('mediaUsage'), false); assert.equal(f.budgetState.size, 0);
  await worker.fetch(request(imageCallback(4, models, 'freeai')), f.env); // wrong stage
  assert.equal(f.state.get('session').imageChoice.token, models.token);
  await worker.fetch(request(imageCallback(5, models, 'gpro')), f.env);
  assert.equal(f.state.get('mediaUsage').image, 1); assert.equal(f.budgetState.get('budget').image, 1);
  assert.ok(f.calls.some(call => call.url === 'https://api.laozhang.ai/v1beta/models/gemini-3-pro-image:generateContent'));
  assert.equal(f.env.LAOZHANG_IMAGE_MODEL, undefined);
  await worker.fetch(request(imageCallback(6, models, 'glite')), f.env);
  assert.equal(f.calls.filter(call => call.url.includes('laozhang.ai')).length, 1);
});

test('the direct LaoZhang command with no default model asks for a Gemini model without spending quota', async () => {
  const f = dualImageSetup(), worker = createWorker(); delete f.env.LAOZHANG_IMAGE_MODEL;
  await worker.fetch(request(update(1, '/image laozhang کلبه')), f.env);
  assert.equal(f.state.get('session').imageChoice.stage, 'model'); assert.equal(f.state.has('mediaUsage'), false);
  await worker.fetch(request(imageCallback(2, f.state.get('session').imageChoice, 'glite')), f.env);
  assert.equal(f.calls.filter(call => call.url.endsWith('/sendPhoto')).length, 1);
});

test('direct per-request Gemini choices share the existing cooldown, quotas and no-fallback rule', async t => {
  let now = 1_800_000_000_000; t.mock.method(Date, 'now', () => now);
  const f = dualImageSetup(), worker = createWorker(); delete f.env.LAOZHANG_IMAGE_MODEL;
  await worker.fetch(request(update(1, '/image laozhang gemini-3.1-flash-image کلبه')), f.env);
  await worker.fetch(request(update(2, '/image laozhang gemini-3-pro-image کلبه')), f.env);
  assert.equal(f.state.get('mediaUsage').image, 1); assert.ok(f.calls.at(-1).body.text.includes('یک دقیقه'));
  now += 60_000;
  await worker.fetch(request(update(3, '/image freeai کلبه')), f.env);
  assert.equal(f.state.get('mediaUsage').image, 2); assert.equal(f.budgetState.get('budget').image, 2);
  now += 60_000;
  await worker.fetch(request(update(4, '/image laozhang gemini-3-pro کلبه')), f.env);
  assert.equal(f.state.get('mediaUsage').image, 2); assert.equal(f.calls.filter(call => call.url.includes('laozhang.ai')).length, 1);
});

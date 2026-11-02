import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, ChatSession, FOLLOWUP_DELAY, FOLLOWUP_TEXT, FOLLOWUP_NOTICE } from './cloudflare.mjs';
import { START_GREETING } from './core.mjs';

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
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret',
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
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.text.includes('هوش مصنوعی'));
  assert.ok(calls[0].body.text.includes('پاسخ زندهٔ شخص امیر نیست'));
  await worker.fetch(request(update(2, '/privacy')), env);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.text.includes('۳۰ پیام'));
  assert.ok(calls[1].body.text.includes('OpenRouter'));
  assert.ok(calls[1].body.text.includes('/stop'));
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, 'نرخ معتبر منبع؛ زمان اعلام‌شده');
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
  assert.equal(calls.length, 2); // short hello + one new weather notice
  assert.ok(!/هوا|باران|برف|آباده/.test(calls[1].body.text));
  assert.ok(!calls[1].body.text.includes('کدوم'));
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

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

function mediaSetup() {
  const rig = setup();
  rig.env.MEDIA_PROVIDER = 'openrouter';
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
    rig.calls.push({ url, body: options.body instanceof FormData ? options.body : JSON.parse(options.body) });
    if (url.endsWith('/images')) return Response.json({ data: [{ b64_json: 'iVBORw0KGgoA', media_type: 'image/png' }] });
    if (url.endsWith('/audio/speech')) {
      if (rig.env.failSpeech) return Response.json({ error: 'private upstream detail' }, { status: 402 });
      return new Response(Uint8Array.from([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: 'با یه قدم کوچیک شروع کن 🌱' } }] });
    return Response.json({ ok: true });
  };
  return { ...rig, budgetState };
}

test('explicit image request uploads one real file only to the requester, no surprise enrollment or duplicate charge', async () => {
  const { env, state, calls, budgetState } = mediaSetup();
  const worker = createWorker();
  await Promise.all([worker.fetch(request(update(1, 'برام یه عکس کلبه برفی بساز')), env), worker.fetch(request(update(1, 'برام یه عکس کلبه برفی بساز')), env)]);
  assert.equal(calls.filter(call => call.url.endsWith('/images')).length, 1);
  const uploads = calls.filter(call => call.url.endsWith('/sendPhoto'));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].body.get('chat_id'), '42');
  assert.equal(uploads[0].body.get('photo').type, 'image/png');
  assert.equal(state.has('weather'), false);
  assert.equal(state.has('followup'), false);
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
  assert.ok(calls.find(call => call.url.endsWith('/sendMessage')).body.text.includes('یه قدم کوچیک'));
  assert.equal(state.get('session').messages.length, 2);
  assert.equal(state.has('weather'), false);
  assert.equal(state.has('followup'), false);
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
  await worker.fetch(request(update(3, '/image ' + 'a'.repeat(2001))), env);
  await worker.fetch(request(update(4, '/image snow', 99)), env);
  const group = update(5, '/image snow'); group.message.chat.type = 'group';
  await worker.fetch(request(group), env);
  env.MEDIA_ENABLED = 'false';
  await worker.fetch(request(update(6, '/image snow')), env);
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
  await worker.fetch(request(update(2, '/image snow')), env);
  assert.ok(calls.at(-1).body.text.includes('یک دقیقه'));
  now += 60_000;
  await worker.fetch(request(update(3, '/image snow')), env);
  for (let id = 20; id < 24; id++) {
    now += 60_000;
    await worker.fetch(request(update(id, '/image snow')), env);
  }
  await worker.fetch(request(update(4, '/reset')), env);
  now += 31 * 60_000;
  const recreated = new ChatSession({ storage }, env);
  await recreated.fetch(request(update(5, '/image snow')));
  assert.ok(calls.at(-1).body.text.includes('سهمیهٔ امروزت'));
  await recreated.fetch(request(update(6, '/voice دوباره شروع')));
  now += 60_000;
  await recreated.fetch(request(update(7, '/voice قدم بعدی')));
  now += 60_000;
  await recreated.fetch(request(update(8, '/voice بیشتر')));
  assert.ok(calls.at(-1).body.text.includes('سهمیهٔ امروزت'));
  assert.equal(calls.filter(call => call.url.endsWith('/images')).length, 5);
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
  assert.ok(messages[0].body.text.includes('یه قدم کوچیک'));
  assert.ok(messages.at(-1).body.text.includes('اعتبار'));
  assert.ok(!JSON.stringify(messages).includes('private upstream'));
  assert.equal(state.get('mediaUsage').voice, 1);
});

test('shared exhausted or unavailable budget fails closed before any paid request', async () => {
  for (const status of [429, 503]) {
    const { env, calls, state } = mediaSetup();
    env.MEDIA.get = () => ({ fetch: async () => new Response('not available', { status }) });
    await createWorker().fetch(request(update(1, '/image snow')), env);
    assert.equal(calls.filter(call => call.url.includes('openrouter')).length, 0);
    assert.equal(state.has('mediaUsage'), false);
    if (status === 429) assert.ok(calls.at(-1).body.text.includes('کل ربات'));
  }
});

test('per-chat budget cleanup alarm survives history expiry and removes only its own data at midnight', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, session, state, calls, alarmAt } = mediaSetup();
  await createWorker().fetch(request(update(1, '/image snow')), env);
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
  delete rig.env.MEDIA_PROVIDER; // new default, even with an OpenRouter chat key
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
  await worker.fetch(request(update(1, '/image کلبه برفی')), env);
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
  assert.equal(state.has('weather'), false);
  assert.equal(state.has('followup'), false);
});

test('missing Free.ai key or voice for a custom model never reserves budget or falls back to OpenRouter', async () => {
  for (const missing of ['FREEAI_API_KEY', 'FREEAI_TTS_VOICE']) {
    const { env, calls, state, budgetState } = freeAIMediaSetup();
    delete env[missing];
    await createWorker().fetch(request(update(1, missing === 'FREEAI_API_KEY' ? '/image snow' : '/voice سلام')), env);
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
  await worker.fetch(request(update(1, '/image snow')), env);
  await worker.fetch(request(update(1, '/image snow')), env);
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
    await worker.fetch(request(update(i, '/image snow', 42)), first.env);
    await worker.fetch(request(update(100 + i, '/image snow', 43)), second.env);
    now += 60_000;
  }
  assert.equal(first.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 5);
  assert.equal(second.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 5);
  assert.equal(first.state.get('mediaUsage').image, 5);
  assert.equal(second.state.get('mediaUsage').image, 5);
  assert.equal(first.budgetState.get('budget').image, 10);
  await worker.fetch(request(update(6, '/image sixth', 42)), first.env);
  assert.ok(first.calls.at(-1).body.text.includes('پنج عکس'));
  assert.equal(first.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 5);
  await worker.fetch(request(update(200, '/image eleventh', 44)), third.env);
  assert.ok(third.calls.at(-1).body.text.includes('ده عکس'));
  assert.equal(third.calls.filter(call => call.url.includes('api.free.ai')).length, 0);
  assert.equal(third.state.has('mediaUsage'), false);
  now = nextMediaDay(now);
  await worker.fetch(request(update(7, '/image new day', 42)), first.env);
  assert.equal(first.calls.filter(call => call.url.endsWith('/v1/image/generate/')).length, 6);
  assert.equal(first.state.get('mediaUsage').image, 1);
  assert.equal(first.budgetState.get('budget').image, 1);
});


test('voice works with just the Free.ai key using default Persian configuration, without surprise enrollment', async () => {
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
  assert.equal(state.has('followup'), false);
  assert.equal(state.has('weather'), false);
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
  assert.ok(messages[0].includes('یه قدم کوچیک'));
  assert.ok(messages.at(-1).includes('MEDIA_HTTP_400_LANGUAGE'));
  assert.ok(!messages.join(' ').includes('private-transcript'));
  assert.ok(!messages.join(' ').includes('sk-free-secret'));
  assert.equal(state.get('mediaUsage').voice, 1);
});

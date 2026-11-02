import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, ChatSession, FOLLOWUP_DELAY, FOLLOWUP_TEXT } from './cloudflare.mjs';
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
  assert.equal(sent[0].body.text, START_GREETING);
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
  assert.equal(state.size, 0);
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

test('without opt-in, cleanup never sends a proactive message', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { env, state, calls, session, alarmAt } = setup();
  await createWorker().fetch(request(update()), env);
  calls.length = 0;
  now += FOLLOWUP_DELAY + 1;
  await session.alarm();
  assert.equal(calls.length, 0);
  assert.equal(state.size, 0);
  assert.equal(alarmAt(), undefined);
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

test('/stop, /reset and /start cancel scheduled check-ins and delete consent metadata', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const command of ['/stop', '/reset', '/start']) {
    const { env, state, calls, session } = setup();
    const worker = createWorker();
    await worker.fetch(request(update(1, '/followup')), env);
    await worker.fetch(request(update(2, command)), env);
    assert.equal(state.has('followup'), false);
    calls.length = 0;
    now += FOLLOWUP_DELAY + 1;
    await session.alarm();
    assert.equal(calls.length, 0);
  }
});

test('failed delivery or revoked user access removes follow-up metadata without retries', async t => {
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
    assert.equal(state.has('followup'), false);
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

test('/start sends only one short greeting, with no AI call or privacy wall', async () => {
  const { env, calls, state } = setup();
  await createWorker().fetch(request(update(1, '/start')), env);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/sendMessage'));
  assert.equal(calls[0].body.text, START_GREETING);
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

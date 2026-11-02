import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, ChatSession } from './cloudflare.mjs';

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

test('verified private message gets disclosure, reply, bounded stored history and cleanup alarm', async () => {
  const worker = createWorker();
  const { env, state, calls, alarmAt } = setup();
  assert.equal((await worker.fetch(request(update()), env)).status, 200);
  const completions = calls.filter(c => c.url.includes('openrouter.ai'));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].body.messages[1].content, 'سلام');
  const sent = calls.filter(c => c.url.includes('sendMessage'));
  assert.ok(sent[0].body.text.startsWith('سلام، من امیرم'));
  assert.ok(sent[0].body.text.includes('هوش مصنوعی'));
  assert.ok(sent[0].body.text.includes('پاسخ زندهٔ شخص امیر نیست'));
  assert.ok(sent[0].body.text.includes('کلودفلر'));
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
  for (const [index, text] of ['/start', '/privacy', '/help', '/reset', '', 'x'.repeat(6001)].entries()) {
    await worker.fetch(request(update(index, text)), env);
  }
  assert.equal(calls.filter(c => c.url.includes('openrouter.ai')).length, 0);
});

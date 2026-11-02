import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from './cloudflare.mjs';

const origin = 'https://hesab-111.abadeh-gamenet.workers.dev';
const secret = 'a1'.repeat(32);
function setup() {
  const calls = [];
  const env = {
    TELEGRAM_BOT_TOKEN: 'private-bot-token', OPENROUTER_API_KEY: 'private-api-key',
    TELEGRAM_WEBHOOK_SECRET: secret, OPENROUTER_MODEL: 'openrouter/auto', TELEGRAM_ALLOWED_USER_IDS: '*',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: url.endsWith('/getWebhookInfo') ? { url: `${origin}/webhook` } : true }));
    },
  };
  return { calls, env, worker: createWorker() };
}
function post(headers = {}) {
  return new Request(`${origin}/setup`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Setup-Secret': secret, ...headers }, body: '{}',
  });
}

test('mobile setup page is non-cacheable, framed off and contains no configured secrets', async () => {
  const { env, worker, calls } = setup();
  const response = await worker.fetch(new Request(`${origin}/setup`), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'self'"));
  const page = await response.text();
  for (const value of [secret, env.TELEGRAM_BOT_TOKEN, env.OPENROUTER_API_KEY]) assert.ok(!page.includes(value));
  assert.ok(page.includes('type="password"'));
  assert.equal(calls.length, 0);
});

test('registration rejects wrong secret, cross-origin forms and absent Origin without API calls', async () => {
  const { env, worker, calls } = setup();
  for (const headers of [{ 'X-Setup-Secret': 'wrong' }, { Origin: 'https://attacker.example' }, { Origin: '' }, { 'Content-Type': 'application/x-www-form-urlencoded' }]) {
    assert.equal((await worker.fetch(post(headers), env)).status, 403);
  }
  const query = new Request(`${origin}/setup?secret=${secret}`);
  await worker.fetch(query, env);
  assert.equal(calls.length, 0);
});

test('registration requires all runtime settings and a strong-length secret', async () => {
  const { env, worker, calls } = setup();
  for (const key of ['OPENROUTER_MODEL', 'TELEGRAM_ALLOWED_USER_IDS', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']) {
    assert.equal((await worker.fetch(post(), { ...env, [key]: '' })).status, 503);
  }
  assert.equal((await worker.fetch(post(), { ...env, TELEGRAM_WEBHOOK_SECRET: 'short' })).status, 503);
  assert.equal(calls.length, 0);
});

test('owner registration uses server-side token, preserves pending updates and verifies webhook', async () => {
  const { env, worker, calls } = setup();
  const response = await worker.fetch(post(), env);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/setWebhook'));
  assert.deepEqual(calls[0].body, { url: `${origin}/webhook`, secret_token: secret, allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false });
  assert.ok(calls[1].url.endsWith('/getWebhookInfo'));
  const text = await response.text();
  assert.ok(text.includes('ثبت شد'));
  assert.ok(!text.includes(env.TELEGRAM_BOT_TOKEN));
  assert.ok(!text.includes(secret));
});

test('provider errors and failed verification return no raw tokens or error bodies', async () => {
  const { env, worker } = setup();
  for (const fetchImpl of [
    async () => { throw new Error(`URL contains ${env.TELEGRAM_BOT_TOKEN}`); },
    async () => new Response('private error', { status: 401 }),
    async () => new Response(JSON.stringify({ ok: true, result: { url: 'https://wrong.example/webhook' } })),
  ]) {
    const response = await worker.fetch(post(), { ...env, fetchImpl });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes(env.TELEGRAM_BOT_TOKEN));
    assert.ok(!text.includes('private error'));
  }
});

test('authenticated diagnostics name only missing settings, including whitespace-only values', async () => {
  const { env, worker, calls } = setup();
  const required = ['TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TELEGRAM_ALLOWED_USER_IDS'];
  for (const key of required) {
    for (const value of [undefined, '', '   ']) {
      const response = await worker.fetch(post(), { ...env, [key]: value });
      assert.equal(response.status, 503);
      const { message } = await response.json();
      assert.ok(message.includes('رمز اتصال پذیرفته شد'));
      for (const name of required) assert.equal(message.includes(name), name === key);
      for (const privateValue of [secret, env.TELEGRAM_BOT_TOKEN, env.OPENROUTER_API_KEY]) assert.ok(!message.includes(privateValue));
    }
  }
  const response = await worker.fetch(post(), { ...env, OPENROUTER_MODEL: '', TELEGRAM_ALLOWED_USER_IDS: '' });
  const { message } = await response.json();
  assert.ok(message.includes('OPENROUTER_MODEL\nTELEGRAM_ALLOWED_USER_IDS'));
  assert.equal(calls.length, 0);
});

test('missing-setting diagnostics are not exposed before owner authentication', async () => {
  const { env, worker } = setup();
  const response = await worker.fetch(post({ 'X-Setup-Secret': 'incorrect' }), { ...env, TELEGRAM_BOT_TOKEN: '', OPENROUTER_API_KEY: '' });
  assert.equal(response.status, 403);
  const text = await response.text();
  assert.ok(!text.includes('TELEGRAM_BOT_TOKEN'));
  assert.ok(!text.includes('OPENROUTER_API_KEY'));
});

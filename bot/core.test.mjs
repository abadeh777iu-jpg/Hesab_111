import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, ConversationStore, splitMessage, systemPrompt, DISCLOSURE } from './core.mjs';

test('bounded history, isolated users and explicit deletion', () => {
  const store = new ConversationStore({ maxMessages: 2, maxUsers: 2 });
  store.save('a', [1, 2, 3, 4]);
  store.save('b', [5]);
  assert.deepEqual(store.get('a'), [3, 4]);
  assert.deepEqual(store.get('b'), [5]);
  store.save('c', [6]);
  assert.deepEqual(store.get('a'), []);
  store.clear('b');
  assert.deepEqual(store.get('b'), []);
});

test('inactive sessions expire', () => {
  let now = 0;
  const store = new ConversationStore({ ttl: 100, now: () => now });
  store.save('a', ['private']);
  now = 100;
  assert.deepEqual(store.get('a'), []);
  assert.equal(store.sessions.size, 0);
});

test('Telegram chunks preserve emoji and content', () => {
  const text = 'سلام 🌱'.repeat(2000);
  const chunks = splitMessage(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 4000 && !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('prompt keeps identity and safety instructions alongside custom style', () => {
  const prompt = systemPrompt('جملات کوتاه');
  assert.ok(prompt.includes('نه صاحب ربات'));
  assert.ok(prompt.includes('خدمات اضطراری'));
  assert.ok(prompt.includes('جملات کوتاه'));
  assert.ok(DISCLOSURE.includes('OpenRouter'));
});

test('OpenRouter request stays server-side and includes system and history', async () => {
  const messages = [{ role: 'user', content: 'سلام' }];
  const result = await complete({ apiKey: 'test-key', model: 'provider/model', messages,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'provider/model');
      assert.equal(body.messages[0].role, 'system');
      assert.deepEqual(body.messages.slice(1), messages);
      assert.equal(body.max_tokens, 700);
      return { ok: true, json: async () => ({ choices: [{ message: { content: ' سلام 🌱 ' } }] }) };
    },
  });
  assert.equal(result, 'سلام 🌱');
});

test('provider errors do not leak provider bodies or secrets', async () => {
  await assert.rejects(complete({ apiKey: 'secret', model: 'test', messages: [],
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), { message: 'OpenRouter HTTP 401' });
});

test('empty responses are rejected instead of sent to Telegram', async () => {
  for (const data of [{}, { choices: [{ message: { content: '  ' } }] }]) {
    await assert.rejects(complete({ apiKey: 'test', model: 'test', messages: [],
      fetchImpl: async () => ({ ok: true, json: async () => data }),
    }), /empty response/);
  }
});

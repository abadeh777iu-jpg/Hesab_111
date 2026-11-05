import test from 'node:test';
import assert from 'node:assert/strict';
import { MembershipGate, membershipRequired, REQUIRED_CHANNEL, CHANNEL_URL, JOIN_KEYBOARD, JOIN_CALLBACK, enableMembershipCallbacks } from './membership.mjs';

function fixture({ status = 'member', is_member, admin = 'administrator', wrongUser = false } = {}) {
  const calls = [];
  const gate = new MembershipGate(async (method, body) => {
    calls.push({ method, body });
    if (method === 'getMe') return { id: 900, is_bot: true };
    assert.equal(method, 'getChatMember'); assert.equal(body.chat_id, REQUIRED_CHANNEL);
    return body.user_id === 900 ? { user: { id: 900 }, status: admin } : { user: { id: wrongUser ? 99 : body.user_id }, status, is_member };
  });
  return { gate, calls };
}

test('join gate is enabled by default and targets exactly the supplied public channel with two inline buttons', () => {
  assert.equal(membershipRequired({}), true);
  assert.equal(membershipRequired({ JOIN_REQUIRED: 'false' }), false);
  assert.equal(REQUIRED_CHANNEL, '@qhatel_roya'); assert.equal(CHANNEL_URL, 'https://t.me/qhatel_roya');
  assert.equal(JOIN_KEYBOARD.inline_keyboard[0][0].url, CHANNEL_URL);
  assert.equal(JOIN_KEYBOARD.inline_keyboard[1][0].callback_data, JOIN_CALLBACK);
});

test('Telegram membership states are interpreted strictly, including restricted is_member', async () => {
  for (const [status, is_member, expected] of [['creator', undefined, 'member'], ['administrator', undefined, 'member'], ['member', undefined, 'member'], ['restricted', true, 'member'], ['restricted', false, 'nonmember'], ['restricted', undefined, 'nonmember'], ['left', undefined, 'nonmember'], ['kicked', undefined, 'nonmember'], ['unknown', undefined, 'unavailable']]) {
    assert.equal(await fixture({ status, is_member }).gate.check(42), expected, status);
  }
  assert.equal(await fixture({ wrongUser: true }).gate.check(42), 'unavailable');
});

test('bot must remain an administrator; no stale positive user membership cache survives another check', async () => {
  const f = fixture(); await f.gate.check(42); await f.gate.check(42);
  assert.equal(f.calls.filter(c => c.method === 'getMe').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'getChatMember').length, 4);
  for (const admin of ['member', 'left', 'kicked', 'restricted']) {
    const f = fixture({ admin }); assert.equal(await f.gate.check(42), 'unavailable');
    assert.equal(f.calls.length, 2); // Never queries a user under unreliable permissions.
  }
});

test('malformed Telegram results, API errors and invalid user IDs fail closed', async () => {
  for (const result of [null, {}, { id: 900, is_bot: false }]) {
    assert.equal(await new MembershipGate(async () => result).check(42), 'unavailable');
  }
  assert.equal(await new MembershipGate(async () => { throw new Error('token and private body'); }).check(42), 'unavailable');
  const f = fixture(); for (const id of [0, -1, '42', NaN]) assert.equal(await f.gate.check(id), 'unavailable');
  assert.equal(f.calls.length, 0);
});

test('existing message-only webhook is upgraded in place with callbacks, keeping secret and pending updates', async () => {
  const calls = [];
  assert.equal(await enableMembershipCallbacks(async (method, body) => {
    calls.push({ method, body });
    return method === 'getWebhookInfo' ? { url: 'https://bot.test/webhook', allowed_updates: ['message'], max_connections: 5 } : true;
  }, 'https://bot.test/webhook', 'fake-secret'), true);
  assert.deepEqual(calls[1], { method: 'setWebhook', body: { url: 'https://bot.test/webhook', secret_token: 'fake-secret', allowed_updates: ['message', 'callback_query', 'channel_post', 'edited_channel_post'], max_connections: 5, drop_pending_updates: false } });
});

test('callback setup never changes unrelated webhooks or re-registers one already accepting callbacks', async () => {
  for (const [url, updates, expected] of [['https://another.test/webhook', ['message'], false], ['https://bot.test/webhook', ['message', 'callback_query', 'channel_post', 'edited_channel_post'], true], ['https://bot.test/webhook', [], true]]) {
    let writes = 0;
    const result = await enableMembershipCallbacks(async method => {
      if (method === 'setWebhook') writes++;
      return { url, allowed_updates: updates, max_connections: 4 };
    }, 'https://bot.test/webhook', 'fake-secret');
    assert.equal(result, expected); assert.equal(writes, 0);
  }
  for (const url of ['http://bot.test/webhook', 'https://bot.test/elsewhere', 'https://user:pass@bot.test/webhook']) {
    assert.equal(await enableMembershipCallbacks(() => { throw new Error('Must not call'); }, url, 'secret'), false);
  }
});

test('an existing one-connection webhook is upgraded to four without narrowing all-updates subscriptions', async () => {
  for (const updates of [undefined, [], ['message', 'callback_query']]) {
    const calls = [];
    assert.equal(await enableMembershipCallbacks(async (method, body) => {
      calls.push({ method, body });
      return method === 'getWebhookInfo' ? { url: 'https://bot.test/webhook', max_connections: 1, allowed_updates: updates } : true;
    }, 'https://bot.test/webhook', 'fake-secret'), true);
    assert.equal(calls[1].body.max_connections, 4); assert.equal(calls[1].body.drop_pending_updates, false);
    assert.deepEqual(calls[1].body.allowed_updates, updates?.length ? [...updates, 'channel_post', 'edited_channel_post'] : []);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableInbox, CapacityHandler, compactUpdate, nextInboxWake, INBOX_TTL, WORK_LEASE } from './load-control.mjs';

function memory() { const state = new Map(); return { state, storage: { get: async k => structuredClone(state.get(k)), put: async (k, v) => state.set(k, structuredClone(v)), delete: async k => state.delete(k) } }; }
const update = (id, text = 'سلام') => ({ update_id: id, webhookURL: 'https://bot.test/webhook', message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text } });
const api = handler => async body => (await handler.fetch(new Request('https://internal/capacity', { method: 'POST', body: JSON.stringify(body) }))).json();

test('queue stores only the minimal authenticated update and clips oversized inputs before persistence', () => {
  const raw = update(1, 'x'.repeat(10000)); raw.message.from.first_name = 'private-name'; raw.message.photo = ['private-file']; raw.webhookURL = 'https://evil.test';
  const safe = compactUpdate(raw, 'https://bot.test/webhook');
  assert.equal(safe.message.text.length, 6001); assert.equal(safe.webhookURL, 'https://bot.test/webhook');
  assert.equal(safe.message.photo, undefined); assert.equal(safe.message.from.first_name, undefined);
});

test('200 simultaneous retries of one update produce one durable job and one admission', async () => {
  const { state, storage } = memory(); const inbox = new DurableInbox(storage); let calls = 0;
  const results = await Promise.all(Array.from({ length: 200 }, () => inbox.admit(update(1), async () => { calls++; return true; })));
  assert.equal(calls, 1); assert.equal(results.filter(r => r.accepted).length, 1);
  assert.equal(state.get('inbox').pending.length, 1);
});

test('per-chat backlog is bounded, overload is explicit/rate-limited, and reset removes older queued text', async () => {
  const { state, storage } = memory(); const inbox = new DurableInbox(storage);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => inbox.admit(update(i), async () => true)));
  assert.equal(results.filter(r => r.accepted).length, 5); assert.equal(results.filter(r => r.notice).length, 1);
  const reset = await inbox.admit(update(21, '/reset'), async () => true);
  assert.equal(reset.removed.length, 5); assert.equal(state.get('inbox').pending.length, 1);
  assert.equal(state.get('inbox').pending[0].update.message.text, '/reset');
});

test('global admission accepts at most 64 ordinary jobs during a 200-user burst and retains a control reserve', async () => {
  const { state, storage } = memory(), call = api(new CapacityHandler({ storage }));
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => call({ op: 'admit', id: 'u' + i })));
  assert.equal(results.filter(r => r.granted).length, 64);
  for (let i = 200; i < 216; i++) assert.equal((await call({ op: 'admit', id: 'u' + i, priority: true })).granted, true);
  assert.equal((await call({ op: 'admit', id: 'u999', priority: true })).granted, false);
  assert.equal(state.get('workTickets').length, 80);
  assert.ok(!JSON.stringify(state.get('workTickets')).includes('سلام'));
});

test('global work leases cap concurrency at four including at most one heavy media job', async () => {
  const { storage } = memory(), call = api(new CapacityHandler({ storage }));
  for (let i = 0; i < 10; i++) await call({ op: 'admit', id: 'u' + i });
  assert.equal((await call({ op: 'start', id: 'u0', kind: 'media' })).granted, true);
  assert.equal((await call({ op: 'start', id: 'u1', kind: 'media' })).granted, false);
  for (let i = 1; i < 4; i++) assert.equal((await call({ op: 'start', id: 'u' + i, kind: 'text' })).granted, true);
  assert.equal((await call({ op: 'start', id: 'u4', kind: 'text' })).granted, false);
  await call({ op: 'finish', id: 'u0' });
  assert.equal((await call({ op: 'start', id: 'u4', kind: 'media' })).granted, true);
});

test('leases recover capacity after crashes and admission tickets expire instead of growing forever', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { state, storage } = memory(), call = api(new CapacityHandler({ storage }));
  for (let i = 0; i < 5; i++) await call({ op: 'admit', id: 'u' + i });
  for (let i = 0; i < 4; i++) await call({ op: 'start', id: 'u' + i });
  now += WORK_LEASE + 1;
  assert.equal((await call({ op: 'start', id: 'u4' })).granted, true);
  now += INBOX_TTL + 1; await call({ op: 'admit', id: 'u6' }); assert.equal(state.get('workTickets').length, 1);
});

test('durable inbox survives object recreation and ingress can continue after a claim', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory(); let inbox = new DurableInbox(storage);
  await inbox.admit(update(1), async () => true); now += 200;
  inbox = new DurableInbox(storage); assert.equal((await inbox.peek()).id, 'u1');
  await inbox.claim('u1'); await inbox.admit(update(2), async () => true);
  assert.equal(state.get('inbox').pending.length, 1); assert.equal(state.get('inbox').active.id, 'u1');
  assert.equal(await inbox.peek(), null); assert.equal(nextInboxWake(state.get('inbox')), now + WORK_LEASE);
  now += WORK_LEASE + 1; assert.equal((await inbox.peek()).recovery, true);
  await inbox.finish('u1'); now += 200; assert.equal((await inbox.peek()).id, 'u2');
});

test('capacity waiting backs off, never drops a pending job, and short-lived receipt cleanup has a wake', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory(); const inbox = new DurableInbox(storage);
  await inbox.admit(update(1), async () => true); await inbox.defer(10000);
  assert.equal(nextInboxWake(state.get('inbox')), now + 10000);
  now += 10001; assert.equal((await inbox.peek()).id, 'u1');
  await inbox.finish('u1'); assert.ok(Number.isFinite(nextInboxWake(state.get('inbox'))));
  now += 31 * 60000; await inbox.cleanup(); assert.equal(state.has('inbox'), false);
});

test('priority controls run before ordinary text but preserve the order of explicit opt-outs', async () => {
  const { state, storage } = memory(), inbox = new DurableInbox(storage);
  await inbox.admit(update(1), async () => true);
  await inbox.admit(update(2, '/stop'), async () => true);
  await inbox.admit(update(3, '/start'), async () => true);
  assert.deepEqual(state.get('inbox').pending.map(j => j.update.message.text), ['/stop', '/start']);
});

test('a retry for a displaced ordinary job cannot postpone a newly queued privacy command', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { state, storage } = memory(), inbox = new DurableInbox(storage);
  await inbox.admit(update(1), async () => true);
  await inbox.admit(update(2, '/stop'), async () => true);
  await inbox.defer(60000, 'u1');
  assert.equal(state.get('inbox').nextAt, now + 100);
  assert.equal(state.get('inbox').pending[0].id, 'u2');
});

test('a job expiring during capacity admission cannot be claimed for a late provider call', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory(), inbox = new DurableInbox(storage);
  await inbox.admit(update(1), async () => true); now += 200;
  assert.equal((await inbox.peek()).id, 'u1'); now += INBOX_TTL;
  assert.equal(await inbox.claim('u1'), null); assert.equal(state.get('inbox').active, null);
});

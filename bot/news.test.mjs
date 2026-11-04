import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewsQuestion, parseNewsFeed, selectNews, NEWS_SOURCES, NewsFeedHandler, newsReply, NEWS_CACHE_MS, NEWS_MAX_AGE } from './news.mjs';

const now = Date.parse('2026-11-04T12:00:00Z');
const [isna, bbc] = NEWS_SOURCES;
const row = (overrides = {}) => ({ title: 'خبر آزمایشی درباره ایران', description: '<b>خلاصهٔ آزمایشی</b> &amp; جزئیات',
  url: 'https://www.isna.ir/news/14050813001/example?tracking=remove#fragment', at: now - 60_000, category: 'اجتماعی', ...overrides });
const xml = rows => `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>${rows.map(item =>
  `<item><title><![CDATA[${item.title}]]></title><description><![CDATA[${item.description}]]></description><link>${item.url.replaceAll('&', '&amp;')}</link><pubDate>${item.at == null ? '' : new Date(item.at).toUTCString()}</pubDate><category>${item.category}</category></item>`).join('')}</channel></rss>`;
const article = (source = isna, overrides = {}) => ({ title: 'تیتر آزمایشی ایران', description: 'خلاصهٔ آزمایشی',
  url: source.id === 'isna' ? 'https://www.isna.ir/news/123/test' : 'https://www.bbc.com/persian/articles/test',
  publishedAt: now - 60_000, source: source.name, sourceId: source.id, ...overrides });
const memory = () => {
  const state = new Map();
  return { state, storage: { get: async key => structuredClone(state.get(key)), put: async (key, value) => state.set(key, structuredClone(value)) } };
};

test('casual Iran news triggers are narrow; personal conversation, media and distress stay in their own paths', () => {
  for (const text of ['چه خبر؟', 'چه‌خبر', 'چه خبرا؟', 'چخبر', 'سلام امیر، چه خبر؟', 'اخبار ایران', 'از ایران چه خبر؟', 'خبرهای ایران رو بگو', '/news', '/news@mybot', 'راستی چه خبر از ایران']) assert.equal(isNewsQuestion(text), true, text);
  for (const text of ['از خودت چه خبر؟', 'چه خبر از کارت؟', 'خبر خوبی ندارم', 'سلام', 'چه خبر از دوستم داری؟', 'حالم بده چه خبر از ایران', '/voice چه خبر', '/image اخبار ایران', 'اخبار جهان', 'خبرهای ایران رو نمی‌خوام']) assert.equal(isNewsQuestion(text), false, text);
});

test('RSS parsing handles CDATA and markup, retains source dates and removes URL tracking', () => {
  const items = parseNewsFeed(xml([row()]), isna, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'خبر آزمایشی درباره ایران');
  assert.equal(items[0].description, 'خلاصهٔ آزمایشی & جزئیات');
  assert.equal(items[0].publishedAt, now - 60_000);
  assert.equal(items[0].url, 'https://www.isna.ir/news/14050813001/example');
  assert.equal(items[0].source, 'ایسنا');
});

test('undated, stale, far-future, unrelated foreign articles and unsafe links are excluded', () => {
  const rows = [row({ at: null }), row({ at: now - NEWS_MAX_AGE - 1000 }), row({ at: now + 6 * 60_000 }),
    row({ url: 'http://www.isna.ir/news/123' }), row({ url: 'https://www.isna.ir.evil.test/news/123' }),
    row({ url: 'https://user:secret@www.isna.ir/news/123' }), row({ url: 'javascript:alert(1)' }),
    row({ url: 'https://127.0.0.1/news/123' }), row({ url: 'https://www.isna.ir/private/123' }),
    row({ title: 'خبر بی‌ربط از انتخابات کشور دیگر', description: 'انتخابات', category: 'جهان' })];
  assert.deepEqual(parseNewsFeed(xml(rows), isna, now), []);
  assert.deepEqual(parseNewsFeed(xml([row({ title: 'خبر ورزشی خارجی', description: 'فوتبال', category: 'ورزش', url: 'https://www.bbc.com/persian/articles/test' })]), bbc, now), []);
});

test('DTD/entities, malformed XML, oversized feeds and deeply nested payloads fail closed', () => {
  for (const data of ['<!DOCTYPE rss [<!ENTITY ext SYSTEM "https://private.test/">]><rss/>', '<rss><channel></rss>', 'x'.repeat(512 * 1024 + 1), '<a>'.repeat(40) + '</a>'.repeat(40)]) assert.throws(() => parseNewsFeed(data, isna, now));
});

test('selection deduplicates, bounds items, balances available sources and filters expired cache', () => {
  const a = article(isna), b = article(bbc, { title: 'خبر آزمایشی دوم از ایران' });
  assert.deepEqual(selectNews([a, { ...a }, b, article(isna, { title: 'خبر قدیمی', publishedAt: now - NEWS_MAX_AGE - 1 })], now), [a, b]);
  assert.equal(selectNews([a, { ...a, title: 'خبر آزمایشی دوم', url: a.url + '2' }, { ...a, title: 'خبر سوم', url: a.url + '3' }], now).length, 2);
});

test('shared cache serializes requests, never sends auth/private data, and refreshes only after 15 minutes', async t => {
  let clock = now; t.mock.method(Date, 'now', () => clock);
  const { storage, state } = memory(); let calls = 0;
  const feed = new NewsFeedHandler({ storage }, { NAVASAN_API_KEY: 'must-not-leak', OPENROUTER_API_KEY: 'must-not-leak', fetchImpl: async (url, options) => {
    calls++;
    assert.ok(NEWS_SOURCES.some(source => source.url === url));
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.equal(options.body, undefined);
    const source = url.includes('isna.ir') ? isna : bbc;
    return new Response(xml([row({ title: 'خبر ایران از ' + source.id, url: source.id === 'isna' ? 'https://www.isna.ir/news/123' : 'https://www.bbc.com/persian/articles/test', at: clock - 60_000 })]), { headers: { 'Content-Type': 'application/rss+xml' } });
  } });
  const replies = await Promise.all([feed.fetch(), feed.fetch(), feed.fetch()]);
  for (const response of replies) assert.equal((await response.json()).items.length, 2);
  assert.equal(calls, 2);
  assert.deepEqual([...state.keys()].sort(), ['newsCache', 'newsNextFetch']);
  assert.ok(!JSON.stringify([...state.values()]).includes('must-not-leak'));
  clock += NEWS_CACHE_MS + 1;
  await feed.fetch(); assert.equal(calls, 4);
});

test('redirects, HTML, excessive streaming and HTTP errors do not trigger follows or rapid retries', async t => {
  t.mock.method(Date, 'now', () => now);
  for (const kind of ['redirect', 'html', 'large-header', 'large-stream', 'http', 'malformed']) {
    const { storage } = memory(); let calls = 0;
    const feed = new NewsFeedHandler({ storage }, { fetchImpl: async () => {
      calls++;
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
      if (kind === 'html') return new Response('<html/>', { headers: { 'Content-Type': 'text/html' } });
      if (kind === 'http') return new Response('private upstream error', { status: 503 });
      if (kind === 'large-header') return new Response('x', { headers: { 'Content-Type': 'application/xml', 'Content-Length': '9999999' } });
      return new Response(kind === 'large-stream' ? 'x'.repeat(512 * 1024 + 1) : '<rss>', { headers: { 'Content-Type': 'text/xml' } });
    } });
    assert.equal((await feed.fetch()).status, 503, kind);
    assert.equal((await feed.fetch()).status, 503, kind);
    assert.equal(calls, 2, kind);
  }
});

test('one available source suffices; expired cache is never presented and older usable cache is marked stale', async t => {
  t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory();
  state.set('newsCache', { items: [article(isna)], fetchedAt: now - NEWS_CACHE_MS - 1 });
  const feed = new NewsFeedHandler({ storage }, { fetchImpl: async () => { throw new Error('private failure'); } });
  const cached = await (await feed.fetch()).json();
  assert.equal(cached.items.length, 1); assert.equal(cached.stale, true);
  state.set('newsCache', { items: [article(isna, { publishedAt: now - NEWS_MAX_AGE - 1 })], fetchedAt: now - NEWS_MAX_AGE });
  assert.equal((await feed.fetch()).status, 503);
  state.clear();
  const partial = new NewsFeedHandler({ storage }, { fetchImpl: async url => {
    if (url.includes('bbci')) throw new Error('Blocked');
    return new Response(xml([row()]), { headers: { 'Content-Type': 'text/xml' } });
  } });
  assert.equal((await (await partial.fetch()).json()).items.length, 1);
});

test('news rewriting sends public excerpts only, isolates private history, keeps token cap and binds citations in code', async () => {
  let calls = 0;
  const html = await newsReply({ OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 320);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].role, 'user');
    assert.ok(body.messages[0].content.includes('غیرقابل‌اعتماد'));
    assert.ok(body.messages[0].content.includes('محاوره‌ای'));
    const data = JSON.parse(body.messages[1].content).untrusted_rss_reports;
    assert.equal(data.length, 2);
    assert.equal(data[0].source, 'ایسنا');
    assert.equal(data[0].url, undefined);
    return Response.json({ choices: [{ message: { content: JSON.stringify([{ id: 1, text: 'ایسنا نوشته این اتفاق تو ایران افتاده.' }, { id: 2, text: 'بی‌بی‌سی هم یه خبر دیگه از ایران داره.' }]) } }] });
  } }, [article(isna), article(bbc)], { fetchedAt: now });
  assert.equal(calls, 1);
  assert.ok(html.includes('ایسنا نوشته'));
  assert.ok(html.includes('href="https://www.isna.ir/news/123/test"'));
  assert.ok(html.includes('href="https://www.bbc.com/persian/articles/test"'));
  assert.ok(html.includes('دریافت خبرها'));
  assert.ok(html.includes('روایت رسانه‌هاست'));
});

test('model errors, malformed/truncated summaries and injected links fall back to source titles without paid retries', async () => {
  for (const output of ['bad JSON', '[{"id":1,"text":"partial"}', JSON.stringify([{ id: 1, text: 'https://evil.test' }]), JSON.stringify([{ id: 99, text: 'wrong id' }]), JSON.stringify([{ id: 1, text: '' }]), 'HTTP402']) {
    let calls = 0;
    const html = await newsReply({ OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async () => {
      calls++;
      if (output === 'HTTP402') return new Response('secret error body', { status: 402 });
      return Response.json({ choices: [{ message: { content: output } }] });
    } }, [article(isna, { title: 'خبر <b>آزمایشی</b> & ایران' })], { stale: true });
    assert.equal(calls, 1);
    assert.ok(html.includes('تیترهای تازه'));
    assert.ok(html.includes('&lt;b&gt;'));
    assert.ok(html.includes('ذخیره‌شده'));
    assert.ok(!html.includes('secret error body'));
    assert.ok(!html.includes('evil.test'));
  }
});


test('one exact JSON code fence from a compatible model is accepted without a second request', async () => {
  let calls = 0;
  const html = await newsReply({ OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: '```json\n[{"id":1,"text":"ایسنا یه خبر از ایران داره."}]\n```' } }] });
  } }, [article(isna)]);
  assert.equal(calls, 1);
  assert.ok(html.includes('ایسنا یه خبر'));
  assert.ok(!html.includes('تیترهای تازه'));
});

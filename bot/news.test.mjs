import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewsQuestion, parseNewsFeed, selectNews, NEWS_SOURCES, NewsFeedHandler, newsReply, NEWS_CACHE_MS, NEWS_MAX_AGE, parseFarsPage, newsFailureMessage, NewsRewriteError } from './news.mjs';

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

test('shared cache serializes requests, never sends auth/private data, and refreshes only at the one-minute boundary', async t => {
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
  assert.equal(calls, NEWS_SOURCES.length);
  assert.deepEqual([...state.keys()].sort(), ['newsCache', 'newsNextFetch']);
  assert.ok(!JSON.stringify([...state.values()]).includes('must-not-leak'));
  assert.equal(NEWS_CACHE_MS, 60_000);
  clock += 59_999; await feed.fetch(); assert.equal(calls, NEWS_SOURCES.length);
  clock++; await feed.fetch(); assert.equal(calls, NEWS_SOURCES.length * 2);
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
    assert.equal(calls, NEWS_SOURCES.length, kind);
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
    const data = JSON.parse(body.messages[1].content).untrusted_news_reports;
    assert.equal(data.length, 2);
    assert.equal(data[0].source, 'ایسنا');
    assert.equal(data[0].url, undefined);
    return Response.json({ choices: [{ message: { content: JSON.stringify([{ id: 1, text: 'ایسنا نوشته این اتفاق تو ایران افتاده.' }, { id: 2, text: 'بی‌بی‌سی هم یه خبر دیگه از ایران داره.' }]) } }] });
  } }, [article(isna), article(bbc)], { fetchedAt: now });
  assert.equal(calls, 1);
  assert.ok(html.includes('ایسنا نوشته'));
  assert.ok(html.includes('href="https://www.isna.ir/news/123/test"'));
  assert.ok(html.includes('href="https://www.bbc.com/persian/articles/test"'));
  assert.ok(html.includes('منبع‌ها'));
  assert.ok(!html.includes('دریافت خبرها'));
});

test('model errors and invalid summaries produce a safe actionable error, never a pretend headline summary or paid retry', async () => {
  for (const output of ['bad JSON', '[{"id":1,"text":"partial"}', JSON.stringify([{ id: 1, text: 'https://evil.test' }]), JSON.stringify([{ id: 99, text: 'wrong id' }]), JSON.stringify([{ id: 1, text: '' }]), 'HTTP402']) {
    let calls = 0;
    await assert.rejects(newsReply({ OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async () => {
      calls++;
      if (output === 'HTTP402') return new Response('secret error body', { status: 402 });
      return Response.json({ choices: [{ message: { content: output } }] });
    } }, [article(isna, { title: 'خبر <b>آزمایشی</b> & ایران' })], { stale: true }), error => {
      assert.ok(error instanceof NewsRewriteError);
      assert.equal(error.code, output === 'HTTP402' ? 'HTTP_402' : 'FORMAT');
      const message = newsFailureMessage(error);
      assert.ok(message.includes('NEWS_'));
      assert.ok(!message.includes('تیترهای تازه'));
      assert.ok(!message.includes('آزمایشی'));
      assert.ok(!message.includes('secret error body'));
      assert.ok(!message.includes('evil.test'));
      return true;
    });
    assert.equal(calls, 1);
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


const fars = NEWS_SOURCES.find(source => source.id === 'fars');
const fox = NEWS_SOURCES.find(source => source.id === 'fox');
const irib = NEWS_SOURCES.find(source => source.id === 'irib');
const channelPost = ({ id = '123', href = 'https://t.me/farsna/123', stamp = new Date(now - 60_000).toISOString(), forwarded = false, body = '<b>خبر آزمایشی ایران</b><br/>خلاصه آزمایشی از تهران &amp; ایران' } = {}) =>
  `<div class="tgme_widget_message" data-post="farsna/${id}">${forwarded ? '<div class="tgme_widget_message_forwarded_from">Forwarded</div>' : ''}<div class="tgme_widget_message_text js-message_text">${body}</div><a class="tgme_widget_message_date" href="${href}"><time datetime="${stamp}">12:00</time></a></div>`;

test('requested publishers have verified direct endpoints or a clearly labelled public Fars channel', () => {
  assert.deepEqual(NEWS_SOURCES.map(source => source.id).sort(), ['bbc', 'fars', 'fox', 'irib', 'isna']);
  assert.equal(irib.url, 'https://www.irib-news.ir/fa/rss/allnews');
  assert.equal(fox.url, 'https://moxie.foxnews.com/google-publisher/world.xml');
  assert.equal(fars.url, 'https://t.me/s/Farsna');
  assert.ok(fars.name.includes('کانال عمومی'));
});

test('Fox Iran/Iranian/Tehran coverage is accepted; unrelated world stories and lookalike terms are excluded', () => {
  const link = 'https://www.foxnews.com/world/test-report';
  for (const title of ['Iran announces a policy', 'IRANIAN official makes a statement', 'Talks in Tehran', 'Iranians discuss a change']) {
    const items = parseNewsFeed(xml([row({ title, description: 'A short report.', category: 'World', url: link })]), fox, now);
    assert.equal(items.length, 1, title); assert.equal(items[0].source, 'فاکس‌نیوز');
  }
  for (const title of ['Tirana election results', 'Canada weather update']) assert.equal(parseNewsFeed(xml([row({ title, description: 'World news.', category: 'World', url: link })]), fox, now).length, 0);
  for (const url of ['https://www.foxnews.com.evil.test/world/test', 'http://www.foxnews.com/world/test', 'https://www.foxnews.com/account/test']) assert.equal(parseNewsFeed(xml([row({ title: 'Iran update', url })]), fox, now).length, 0);
});

test('IRIB accepts its current canonical host and dated Iran reports, not the obsolete domain or foreign reports', () => {
  const rows = [row({ url: 'https://www.irib-news.ir/fa/news/123/test' }), row({ url: 'https://www.iribnews.ir/fa/news/123/test' })];
  const items = parseNewsFeed(xml(rows), irib, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'خبرگزاری صداوسیما');
});

test('public Fars HTML uses post dates and permalinks; forwarded, unsafe, media-only and undated posts are not news', () => {
  const items = parseFarsPage('<html><body>' + channelPost() + '</body></html>', fars, now);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'خبر آزمایشی ایران');
  assert.equal(items[0].description, 'خلاصه آزمایشی از تهران & ایران');
  assert.equal(items[0].url, 'https://t.me/farsna/123');
  assert.equal(items[0].publishedAt, now - 60_000);
  assert.equal(parseFarsPage(channelPost({ body: '🔴<br/>خبر آزمایشی ایران<br/>توضیح خبر' }), fars, now)[0].title, 'خبر آزمایشی ایران');
  assert.equal(parseFarsPage(channelPost({ href: 'https://t.me/Farsna/123' }), fars, now).length, 1);
  for (const bad of [{ forwarded: true }, { stamp: '' }, { stamp: '2026-11-04' }, { stamp: new Date(now - NEWS_MAX_AGE - 1).toISOString() }, { stamp: new Date(now + 360_000).toISOString() }, { body: '' }, { href: 'https://t.me/other/123' }, { href: 'https://t.me/farsna/999' }, { href: 'https://evil.test/farsna/123' }, { body: 'Unrelated world story' }]) assert.deepEqual(parseFarsPage(channelPost(bad), fars, now), [], JSON.stringify(bad));
  assert.deepEqual(parseFarsPage('<html>login required</html>', fars, now), []);
  assert.throws(() => parseFarsPage('x'.repeat(512 * 1024 + 1), fars, now));
  assert.throws(() => parseFarsPage('<div>'.repeat(90) + '</div>'.repeat(90), fars, now));
});

test('minute rotation gives every available publisher coverage without user counters or flooding a two-news answer', () => {
  const items = NEWS_SOURCES.map((source, index) => article(source, { title: `خبر آزمایشی ایران ${index}`, url: source.url, publishedAt: now - 60_000 }));
  const seen = new Set();
  for (let minute = 0; minute < 6; minute++) {
    const selected = selectNews(items, now + minute * 60_000);
    assert.equal(selected.length, 2);
    assert.equal(selected.filter(item => ['bbc', 'fox'].includes(item.sourceId)).length, 1);
    for (const item of selected) seen.add(item.sourceId);
  }
  assert.deepEqual([...seen].sort(), NEWS_SOURCES.map(source => source.id).sort());
});

test('upgrade ignores legacy fifteen-minute cache/retry deadlines and fetches all five sources immediately', async t => {
  t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory();
  state.set('newsCache', { items: [article(isna)], fetchedAt: now - 10_000 });
  state.set('newsNextFetch', now + 15 * 60_000);
  let calls = 0;
  const feed = new NewsFeedHandler({ storage }, { fetchImpl: async () => { calls++; return new Response('Unavailable', { status: 503 }); } });
  const response = await (await feed.fetch()).json();
  assert.equal(calls, 5); assert.equal(response.stale, true);
  assert.equal(state.get('newsNextFetch').at, now + 60_000);
  await feed.fetch(); assert.equal(calls, 5);
});


test('large Fox RSS has a source-specific one-MiB bound, not an unbounded or global size increase', () => {
  const large = xml([row({ title: 'Iran test', url: 'https://www.foxnews.com/world/iran-test' })]).replace('</channel>', '<unused>' + 'x'.repeat(600 * 1024) + '</unused></channel>');
  assert.equal(parseNewsFeed(large, fox, now).length, 1);
  assert.throws(() => parseNewsFeed(large, isna, now));
  assert.throws(() => parseNewsFeed('x'.repeat(1024 * 1024 + 1), fox, now));
});

test('without model credit, Fox translation fails honestly instead of replacing a friendly Persian story with English headlines', async () => {
  let calls = 0;
  await assert.rejects(newsReply({ OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async () => {
    calls++;
    return new Response('private billing rejection', { status: 402 });
  } }, [article(fox, { title: 'Iran test report', description: 'An attributed claim.', url: 'https://www.foxnews.com/world/iran-test' })]), error => {
    assert.equal(error.code, 'HTTP_402');
    const message = newsFailureMessage(error);
    assert.ok(message.includes('OpenRouter'));
    assert.ok(message.includes('NEWS_HTTP_402'));
    assert.ok(!message.includes('Iran test report'));
    assert.ok(!message.includes('private billing rejection'));
    return true;
  });
  assert.equal(calls, 1);
});

test('a normal friendly Persian narrative is accepted directly, even beyond the old 280-character limit', async () => {
  const story = 'راستی، ایسنا نوشته یه طرح آزمایشی تو ایران مطرح شده، ولی هنوز نتیجه‌ای ازش اعلام نکرده. از اون طرف، فاکس به نقل از یه مقام دربارهٔ ایران گزارشی داده؛ حرف اون مقامه، نه چیزی که جداگانه تأیید شده باشه. ' + 'این توضیح ساختگی فقط برای آزمون لحن و پذیرش پاسخ پیوسته است. '.repeat(3);
  assert.ok(story.length > 280);
  let calls = 0;
  const html = await newsReply({ OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async () => {
    calls++;
    return Response.json({ choices: [{ message: { content: story } }] });
  } }, [article(isna), article(fox, { title: 'Iran synthetic test report', url: 'https://www.foxnews.com/world/test' })]);
  assert.equal(calls, 1);
  assert.ok(html.startsWith('راستی، ایسنا نوشته'));
  assert.ok(html.includes('از اون طرف'));
  assert.ok(html.includes('منبع‌ها'));
  assert.ok(!html.includes('تیتر آزمایشی ایران'));
  assert.ok(!html.includes('خلاصه‌شون کنم'));
  assert.equal(html.split('\n\n').length, 2);
});

test('rewrite failure categories never echo upstream errors, tokens or URLs', async () => {
  for (const [failure, expected] of [[new DOMException('secret URL', 'TimeoutError'), 'TIMEOUT'], [new Error('https://secret.test?api_key=private'), 'CONNECTION']]) {
    await assert.rejects(newsReply({ fetchImpl: async () => { throw failure; } }, [article(isna)]), error => {
      assert.equal(error.code, expected);
      assert.ok(!newsFailureMessage(error).includes('secret'));
      assert.ok(!newsFailureMessage(error).includes('private'));
      return true;
    });
  }
  await assert.rejects(newsReply({ fetchImpl: async () => Response.json({ choices: [{ message: { content: '' } }] }) }, [article(isna)]), { code: 'EMPTY' });
});

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { complete } from './core.mjs';
import { escapeHtml } from './format.mjs';
import { localTime } from './live-data.mjs';

// Fixed public RSS endpoints only. No user URL, key, article fetch or paid news API.
export const NEWS_SOURCES = Object.freeze([
  { id: 'isna', name: 'ایسنا', url: 'https://www.isna.ir/rss/tp/1', hosts: ['www.isna.ir', 'isna.ir'], path: '/news/' },
  { id: 'bbc', name: 'بی‌بی‌سی فارسی', url: 'https://feeds.bbci.co.uk/persian/rss.xml', hosts: ['www.bbc.com', 'www.bbc.co.uk'], path: '/persian/' },
]);
export const NEWS_CACHE_MS = 15 * 60_000;
export const NEWS_MAX_AGE = 24 * 60 * 60_000;
export const NEWS_UNAVAILABLE = 'الان خبر تازهٔ قابل‌اتکایی از ایران دستم نیست؛ نمی‌خوام از خودم چیزی بگم. کمی بعد ازم بپرس 🌱';
const MAX_FEED_BYTES = 512 * 1024;
const MAX_ITEMS = 2;

export function isNewsQuestion(text) {
  if (/^\/news(?:@[a-z0-9_]+)?$/i.test(text.trim())) return true;
  const clean = text.normalize('NFKC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\u200c/g, ' ')
    .replace(/[؟?!،,.;؛:]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:(?:سلام|امیر|رفیق|خب|راستی|داداش)\s+){0,4}(?:چه\s*خبر(?:ا|ها)?|چخبر(?:ا)?|اخبار(?: ایران)?|خبرهای ایران|خبر ایران|از ایران چه خبر)(?: (?:از ایران|تو ایران|ایران|امروز))?(?: (?:داری|بگو|رو بگو))?$/u.test(clean);
}

function plain(value, limit) {
  if (typeof value !== 'string') return '';
  value = value.slice(0, 4096).replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => {
    const cp = parseInt(hex || dec, hex ? 16 : 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]);
  const clean = value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, limit).join('');
}
function fresh(at, now) {
  return Number.isFinite(at) && at > 0 && at <= now + 5 * 60_000 && now - at <= NEWS_MAX_AGE;
}
function safeLink(value, source) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, source.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !source.hosts.includes(url.hostname) || !url.pathname.startsWith(source.path) || url.href.length > 1800) return null;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}
const iran = /ایران|تهران|جمهوری اسلامی|خلیج فارس|آباده|اصفهان|شیراز|مشهد|تبریز|خوزستان|کرمان|گیلان|مازندران|اردبیل|قم|زنجان|سمنان|بوشهر|سیستان|هرمزگان|چهارمحال|لرستان|ایلام|قزوین|همدان|یزد|البرز|اراک|ارومیه|سنندج|بندرعباس/u;

export function parseNewsFeed(xml, source, now = Date.now()) {
  if (typeof xml !== 'string' || new TextEncoder().encode(xml).length > MAX_FEED_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid news feed');
  if (XMLValidator.validate(xml) !== true) throw new Error('Invalid news XML');
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false, htmlEntities: true, maxNestedTags: 20 }).parse(xml);
  const raw = parsed?.rss?.channel?.item;
  if (!raw) return [];
  const rows = Array.isArray(raw) ? raw : [raw];
  const result = [];
  for (const row of rows.slice(0, 150)) {
    const title = plain(row.title, 240);
    const description = plain(row.description, 600);
    const url = safeLink(row.link, source);
    const publishedAt = typeof row.pubDate === 'string' ? Date.parse(row.pubDate) : NaN;
    const category = (Array.isArray(row.category) ? row.category : [row.category]).map(value => plain(value, 100)).join(' ');
    // General Persian feeds also carry foreign stories. Keep Iran-related stories,
    // plus ISNA's explicitly domestic sections, not unrelated world headlines.
    const domestic = source.id === 'isna' && /استان|اجتماعی|اقتصادی|سیاسی|فرهنگ/u.test(category) && !/جهان|بین.?الملل/u.test(category);
    if (!title || !url || !fresh(publishedAt, now) || (!iran.test(title + ' ' + description) && !domestic)) continue;
    result.push({ title, description, url, publishedAt, source: source.name, sourceId: source.id });
  }
  return result;
}

async function fetchNewsSource(source, fetchImpl) {
  const response = await fetchImpl(source.url, { redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
  const type = response.headers.get('Content-Type')?.toLowerCase() || '';
  if (!response.ok || !/(?:application\/(?:rss\+xml|xml)|text\/xml)/.test(type)) {
    await response.body?.cancel(); throw new Error('News HTTP or MIME');
  }
  if (Number(response.headers.get('Content-Length')) > MAX_FEED_BYTES) {
    await response.body?.cancel(); throw new Error('Large news feed');
  }
  if (!response.body) throw new Error('Empty news feed');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) { await reader.cancel(); throw new Error('Large news feed'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return parseNewsFeed(new TextDecoder('utf-8', { fatal: true }).decode(bytes), source);
}

export function selectNews(items, now = Date.now()) {
  const seen = new Set();
  const unique = items.filter(item => fresh(item.publishedAt, now)).sort((a, b) => b.publishedAt - a.publishedAt).filter(item => {
    const titleKey = item.title.normalize('NFKC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[\s\p{P}]+/gu, '');
    if (seen.has(item.url) || seen.has(titleKey)) return false;
    seen.add(item.url); seen.add(titleKey); return true;
  });
  // Prefer one story from each available source, rather than implying that a
  // single publisher constitutes independent corroboration.
  const selected = [];
  for (const item of unique) if (!selected.some(other => other.sourceId === item.sourceId)) selected.push(item);
  for (const item of unique) if (selected.length < MAX_ITEMS && !selected.includes(item)) selected.push(item);
  return selected.slice(0, MAX_ITEMS).sort((a, b) => b.publishedAt - a.publishedAt);
}

// Separate object name in the existing MARKETS namespace: no new migration,
// no Navasan request/budget changes, no user identifiers in shared storage.
export class NewsFeedHandler {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  fetch() {
    const task = this.queue.then(() => this.latest());
    this.queue = task.catch(() => {});
    return task;
  }
  async latest() {
    const now = Date.now();
    const cache = await this.ctx.storage.get('newsCache');
    const cachedItems = selectNews(cache?.items || [], now);
    const reply = (items, stale = false, fetchedAt = cache?.fetchedAt || null) => Response.json({ items, stale, fetchedAt }, { status: items.length ? 200 : 503 });
    if (cachedItems.length && cache.fetchedAt <= now && now - cache.fetchedAt < NEWS_CACHE_MS) return reply(cachedItems);
    if ((await this.ctx.storage.get('newsNextFetch')) > now) return reply(cachedItems, true);
    // Reserve before I/O; failures and concurrent readers cannot hammer RSS.
    await this.ctx.storage.put('newsNextFetch', now + NEWS_CACHE_MS);
    const results = await Promise.allSettled(NEWS_SOURCES.map(source => fetchNewsSource(source, this.env.fetchImpl || fetch)));
    const items = selectNews(results.flatMap(result => result.status === 'fulfilled' ? result.value : []));
    if (items.length) {
      await this.ctx.storage.put('newsCache', { items, fetchedAt: now });
      return reply(items, false, now);
    }
    // Cached stories are still explicitly timestamped, never beyond 24 hours.
    return reply(cachedItems, true);
  }
}

export async function newsReply(env, items, metadata = {}) {
  let summaries = null;
  try {
    const text = await complete({ apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL,
      style: env.BOT_STYLE, messages: [], newsItems: items.map((item, index) => ({ id: index + 1,
        title: item.title, excerpt: item.description, source: item.source })),
      fetchImpl: env.fetchImpl || fetch, timeoutMs: 12_000 });
    // Some compatible chat models wrap otherwise valid JSON in one code fence.
    const payload = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed) || parsed.length !== items.length || parsed.some((item, index) =>
      item?.id !== index + 1 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 280 || /https?:|www\.|\[OPINION\]/i.test(item.text))) throw new Error('Invalid news summary');
    summaries = parsed.map(item => plain(item.text, 280));
    if (summaries.some(text => !text)) throw new Error('Empty news summary');
  } catch { /* No paid retries; show attributed source headlines, not invented news. */ }
  const cacheNotice = metadata.stale ? 'منبع‌ها الان خبر تازه ندادن؛ اینا آخرین خبرهای ذخیره‌شده‌ان:\n\n' : '';
  const intro = summaries ? '' : 'الان نتونستم خودمونی خلاصه‌شون کنم؛ اینا تیترهای تازهٔ منبع‌هان:\n\n';
  const parts = items.map((item, index) => `${escapeHtml(summaries ? summaries[index] : item.title)}\n<a href="${escapeHtml(item.url)}">${escapeHtml(item.source)}</a> · ${escapeHtml(localTime(item.publishedAt, 'Asia/Tehran'))}`);
  const fetched = Number.isFinite(metadata.fetchedAt) ? `\nدریافت خبرها: ${escapeHtml(localTime(metadata.fetchedAt, 'Asia/Tehran'))}` : '';
  return `${cacheNotice}${intro}${parts.join('\n\n')}${fetched}\n\nروایت رسانه‌هاست؛ برای جزئیات، لینک‌ها رو ببین. ساعت‌ها به وقت تهرانه.`;
}

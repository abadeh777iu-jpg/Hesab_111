import { parseDocument } from 'htmlparser2';

export const INSTAGRAM_PROVIDER = 'https://www.vxinstagram.com';
export const MUSIC_PROVIDER = 'https://songfinder.dev/api/music/recognize';
export const IG_PERSONAL_LIMIT = 5;
export const IG_GLOBAL_LIMIT = 10;
export const IG_JOB_TTL = 30 * 60_000;
export const nextInstagramJob = record => Math.min(Infinity, ...(record?.instagramJobs || []).map(job => job.expiresAt));
export const MAX_IG_VIDEO = 20 * 1024 * 1024;
export const isMusicCallback = value => typeof value === 'string' && /^igmusic:[a-f0-9]{32}$/.test(value);
export const igDayEnd = (now = Date.now()) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
export class InstagramError extends Error { constructor(code) { super('Public media unavailable'); this.code = code; } }
export function instagramFailure(error) {
  if (error?.code === 'LIMIT') return 'سقف رایگان این بخش برای امروز پر شده؛ فردا دوباره امتحان کن 🌱';
  if (error?.code === 'RATE') return 'برای رعایت محدودیت سرویس رایگان، حدود یک دقیقه صبر کن و دوباره امتحان کن 🌱';
  if (error?.code === 'SIZE') return 'این ویدئو از سقف ۲۰ مگابایت ربات بزرگ‌تره؛ فعلاً نمی‌تونم فایلش رو بفرستم 🌱';
  if (error?.code === 'NO_MATCH') return 'سرویس نتونست موسیقی این ویدئو رو شناسایی کنه؛ اسم آهنگ رو حدس نمی‌زنم 🌱';
  return 'این بار نتونستم فایل یا نتیجهٔ قابل‌اعتماد بگیرم 🌱 ممکنه لینک در دسترس نباشه یا سرویس رایگان محدود یا قطع شده باشه. ورود به حساب یا دورزدن محدودیت انجام نمی‌دم؛ بعداً دوباره امتحان کن.';
}
export function canonicalInstagram(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const u = new URL(value);
    if (u.protocol !== 'https:' || !['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(u.hostname) || u.port || u.username || u.password) return null;
    const m = /^\/(p|reel|reels)\/([A-Za-z0-9_-]{5,64})\/?$/.exec(u.pathname);
    return m ? `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/` : null;
  } catch { return null; }
}
export function instagramRequest(text) {
  const urls = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const candidates = urls.filter(url => { try { return ['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(new URL(url).hostname); } catch { return false; } });
  if (!candidates.length) return null;
  return { url: urls.length === 1 ? canonicalInstagram(candidates[0].replace(/[),.!،؟]+$/u, '')) : null };
}
export function safeInstagramVideo(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || value.length > 4096 || u.hash || !u.pathname.toLowerCase().endsWith('.mp4')) return null;
    if (!/^(?:instagram|scontent)[a-z0-9.-]*\.fbcdn\.net$/.test(u.hostname) && !/^scontent[a-z0-9.-]*\.cdninstagram\.com$/.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
export async function boundedBody(response, max, type, sizeCode = 'SOURCE') {
  if (!response.ok || !type.test(response.headers.get('Content-Type') || '') || Number(response.headers.get('Content-Length')) > max || !response.body) {
    await response.body?.cancel(); throw new InstagramError(Number(response.headers.get('Content-Length')) > max ? sizeCode : 'SOURCE');
  }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new InstagramError(sizeCode); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!length) throw new InstagramError('SOURCE');
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export function parseInstagramPage(html) {
  if (new TextEncoder().encode(html).length > 512 * 1024) throw new InstagramError('SOURCE');
  const doc = parseDocument(html, { decodeEntities: true });
  const choices = [], stack = [[doc, 0]]; let visited = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (++visited > 20000 || depth > 80) throw new InstagramError('SOURCE');
    const a = node.attribs || {};
    if (node.name === 'meta' && ['og:video', 'og:video:url', 'og:video:secure_url'].includes(a.property)) choices.push({ value: a.content, rank: 2 });
    if (['video', 'source'].includes(node.name)) choices.push({ value: a.src, rank: 0 });
    for (let i = (node.children?.length || 0) - 1; i >= 0; i--) stack.push([node.children[i], depth + 1]);
  }
  // Prefer the actual source over OG: some provider templates append .mp4
  // after a signed query in OG, while <source src> retains the correct URL.
  const video = choices.sort((a, b) => a.rank - b.rank).map(e => safeInstagramVideo(e.value)).find(Boolean);
  if (!video) throw new InstagramError('SOURCE');
  return video;
}
export async function resolveInstagram(fetchImpl, url) {
  url = canonicalInstagram(url); if (!url) throw new InstagramError('INPUT');
  let target = INSTAGRAM_PROVIDER + new URL(url).pathname;
  for (let i = 0; i < 3; i++) {
    const response = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: 'text/html' } });
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location'); await response.body?.cancel();
      const next = new URL(location || '', target);
      if (!location || next.protocol !== 'https:' || !['vxinstagram.com', 'www.vxinstagram.com'].includes(next.hostname) || next.username || next.password || next.port || next.search || next.hash || next.pathname !== new URL(url).pathname) throw new InstagramError('SOURCE');
      target = next.href; continue;
    }
    const bytes = await boundedBody(response, 512 * 1024, /^text\/html(?:;|$)/i);
    return parseInstagramPage(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  throw new InstagramError('SOURCE');
}
export async function downloadInstagramVideo(fetchImpl, url) {
  const safe = safeInstagramVideo(url); if (!safe) throw new InstagramError('SOURCE');
  const response = await fetchImpl(safe, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { Accept: 'video/mp4' } });
  const bytes = await boundedBody(response, MAX_IG_VIDEO, /^video\/mp4(?:;|$)/i, 'SIZE');
  if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(4, 8)) !== 'ftyp') throw new InstagramError('SOURCE');
  return bytes;
}
const plain = value => typeof value === 'string' ? value.replace(/https?:\/\/\S+/gi, '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 180) : '';
export function safeMusicLink(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || value.length > 1200) return null;
    const ok = (u.hostname === 'open.spotify.com' && /^\/track\/[a-zA-Z0-9]+$/.test(u.pathname)) ||
      (['shazam.com', 'www.shazam.com'].includes(u.hostname) && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:track|song)\/\d+(?:\/[^/]*)?$/.test(u.pathname)) ||
      (u.hostname === 'music.apple.com' && /^\/[a-z]{2}\/(?:album|song|music-video)\//.test(u.pathname));
    if (!ok) return null;
    const song = u.searchParams.get('i'); u.search = ''; u.hash = '';
    if (u.hostname === 'music.apple.com' && /^\d+$/.test(song || '')) u.searchParams.set('i', song);
    return u.href;
  } catch { return null; }
}
export function parseRecognizedMusic(payload) {
  if (payload?.code !== 0 || payload.data?.matched !== true) throw new InstagramError(payload?.code === 0 ? 'NO_MATCH' : 'SOURCE');
  const d = payload.data, title = plain(d.title), artist = plain(d.artist);
  if (!title || !artist) throw new InstagramError('SOURCE');
  const link = [d.appleMusicUrl, d.spotifyUrl, d.songLink].map(safeMusicLink).find(Boolean) || null;
  return { title, artist, link, uncertain: Number.isFinite(d.score) && d.score < 70 };
}
export async function recognizeInstagramMusic(fetchImpl, url) {
  url = canonicalInstagram(url); if (!url) throw new InstagramError('INPUT');
  const form = new FormData(); form.set('url', url); form.set('source', 'cli');
  // This is the provider's documented non-browser client contract, not a key,
  // scraped session or CAPTCHA token. 403/429 stop; no evasion or paid fallback.
  const response = await fetchImpl(MUSIC_PROVIDER, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(35000),
    headers: { Accept: 'application/json', 'X-SongFinder-Client': 'cli' }, body: form });
  if (response.status === 429) { await response.body?.cancel(); throw new InstagramError('RATE'); }
  const bytes = await boundedBody(response, 64 * 1024, /^application\/json(?:;|$)/i);
  return parseRecognizedMusic(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export function musicReply(track) {
  return `${track.uncertain ? 'تطبیق احتمالی' : 'آهنگی که سرویس پیدا کرد'} 🎵\n${track.title}\nخواننده: ${track.artist}\n${track.link ? `پخش رسمی: ${track.link}` : 'لینک پخش رسمیِ معتبر در پاسخ سرویس نبود.'}\nشناسایی: SongFinder\nفایل کامل با اجازهٔ دانلود در این نتیجه موجود نیست؛ فایل آهنگ رو از منبع نامشخص نمی‌فرستم.`;
}
export async function uploadInstagramVideo(env, chat, bytes, token, original) {
  if (!isMusicCallback('igmusic:' + token) || !canonicalInstagram(original) || bytes.length > MAX_IG_VIDEO) throw new InstagramError('INPUT');
  const body = new FormData(); body.set('chat_id', String(chat)); body.set('supports_streaming', 'true');
  body.set('caption', `ویدئوی عمومی از اینستاگرام 🌱 (اولین ویدئو، حداکثر ۲۰ مگابایت)\n${canonicalInstagram(original)}\nدریافت: vxInstagram\nبا زدن دکمه، فقط لینک عمومی برای شناسایی به SongFinder فرستاده می‌شه. دکمه تا ۳۰ دقیقه فعاله.`);
  body.set('reply_markup', JSON.stringify({ inline_keyboard: [[{ text: '🎵 شناسایی موسیقی', callback_data: 'igmusic:' + token }]] }));
  body.set('video', new Blob([bytes], { type: 'video/mp4' }), 'instagram.mp4');
  const response = await (env.fetchImpl || fetch)(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVideo`, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(25000) });
  const data = JSON.parse(new TextDecoder().decode(await boundedBody(response, 64 * 1024, /^application\/json(?:;|$)/i)));
  if (data.ok !== true || !Number.isSafeInteger(data.result?.message_id) || !data.result?.video) throw new InstagramError('DELIVERY');
  return data.result.message_id;
}

// Separate public-data object and budgets; never touches prices or media quotas.
export class InstagramFeedHandler {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  fetch(request) { const task = this.queue.then(() => this.handle(request)); this.queue = task.catch(() => {}); return task; }
  async handle(request) {
    try {
      const { url: raw } = await request.json(), url = canonicalInstagram(raw);
      const kind = new URL(request.url).pathname === '/ig-resolve' ? 'video' : new URL(request.url).pathname === '/ig-recognize' ? 'music' : null;
      if (!url || !kind) throw new InstagramError('INPUT');
      const now = Date.now(), end = igDayEnd(now), cacheKey = 'igCache:' + kind;
      const cache = (await this.ctx.storage.get(cacheKey) || []).filter(e => e.at <= now && now - e.at < (kind === 'video' ? 5 * 60000 : IG_JOB_TTL)).slice(-10);
      const hit = cache.find(e => e.url === url);
      if (hit) return Response.json({ ok: true, value: hit.value });
      let budget = await this.ctx.storage.get('igBudget');
      if (budget?.expiresAt !== end) budget = { expiresAt: end, video: 0, music: 0, videoAt: 0, musicAt: 0 };
      if (budget[kind] >= IG_GLOBAL_LIMIT) throw new InstagramError('LIMIT');
      if (budget[kind + 'At'] && now - budget[kind + 'At'] < 60000) throw new InstagramError('RATE');
      budget[kind]++; budget[kind + 'At'] = now; await this.ctx.storage.put('igBudget', budget);
      const value = kind === 'video' ? await resolveInstagram(this.env.fetchImpl || fetch, url) : await recognizeInstagramMusic(this.env.fetchImpl || fetch, url);
      await this.ctx.storage.put(cacheKey, [...cache, { url, value, at: Date.now() }].slice(-10));
      return Response.json({ ok: true, value });
    } catch (error) { return Response.json({ ok: false, code: error instanceof InstagramError ? error.code : 'SOURCE' }, { status: 503 }); }
  }
}

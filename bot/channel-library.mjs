// Public, owner-selected Telegram channel only. Never send catalogue text to an AI.
export const LIBRARY_CHANNEL = '@qhatel_roya';
export const CHANNEL_UPDATES = ['message', 'callback_query', 'channel_post', 'edited_channel_post'];
export const LIBRARY_TTL = 30 * 86400000;
export const automaticChannelPosts = env => env.CHANNEL_CONFIRMATION_REQUIRED !== 'true';
export const AUTO_POST_INTERVAL = 24 * 60 * 60_000;
export const OFFER_TTL = 10 * 60000;
export const LIBRARY_LIMIT = 200;
export const isChannelCallback = data => typeof data === 'string' && /^chpick:[a-f0-9]{32}$/.test(data);
const safeId = id => Number.isSafeInteger(id) && id > 0;
const channelId = id => Number.isSafeInteger(id) && id < 0;
const clean = (value, max = 600) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '';
export const normalizeChannelText = text => clean(text, 2000).normalize('NFKC').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\u064b-\u065f\u0670\u200c]/g, '').toLowerCase();
const hasWord = (text, pattern) => new RegExp('(?:^|[^\\p{L}\\p{N}])(?:' + pattern + ')(?=$|[^\\p{L}\\p{N}])', 'u').test(text);
const inferKind = text => hasWord(text, 'آهنگ(?:ی|ها|های)?|موسیقی|موزیک') ? 'song' : hasWord(text, 'کلیپ(?:ی|ها|های)?|ویدیو|ویدئو|فیلم(?:ی|ها|های)?') ? 'video' : hasWord(text, 'جمله(?:ای|ها|های)?|نقل قول') || /متن (?:قشنگ|کوتاه|انگیزشی|از کانال)/.test(text) ? 'quote' : null;
const labels = { song: 'آهنگ', video: 'کلیپ', quote: 'جمله' };
export const channelKindLabel = kind => labels[kind] || 'پست';

// Called only after validating the Telegram webhook secret. Nothing from private
// forwards, arbitrary groups, profiles or other channels enters the catalogue.
export function compactChannelPost(update) {
  const post = update.channel_post || update.edited_channel_post;
  if (!post || (update.channel_post && update.edited_channel_post) || update.message || update.callback_query ||
      post.chat?.type !== 'channel' || !channelId(post.chat.id) ||
      String(post.chat.username || '').toLowerCase() !== LIBRARY_CHANNEL.slice(1) ||
      !safeId(post.message_id) || !safeId(post.date)) return null;
  let kind = null;
  if (!post.has_protected_content && !post.paid_media) {
    if (post.audio || /^audio\//i.test(post.document?.mime_type || '')) kind = 'song';
    else if (post.video || post.animation || /^video\//i.test(post.document?.mime_type || '')) kind = 'video';
    else if (typeof post.text === 'string' && post.text.trim()) kind = 'quote';
  }
  const title = clean(post.audio?.title || post.document?.file_name, 100);
  const performer = clean(post.audio?.performer, 100);
  return { channelId: post.chat.id, id: post.message_id, version: update.update_id, revisionAt: safeId(post.edit_date) ? post.edit_date : post.date, date: post.date,
    kind, text: kind ? clean(post.text || post.caption) : '', title: kind ? title : '', performer: kind ? performer : '' };
}

export function channelRequest(text) {
  const normalized = normalizeChannelText(text);
  if (/نفرست|نمیخوام|نمیخواهم|خودکشی|خودآزاری|آسیب به خود|بمیرم|خود(?:مو|م را|م رو|م)\s*بکشم|زندگی.*(?:تموم|تمام) کنم|suicid|kill\s+myself|self[- ]?harm/i.test(normalized)) return null;
  const match = normalized.match(/^\/(song|clip|quote|channel)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (match) {
    const kind = { song: 'song', clip: 'video', quote: 'quote' }[match[1]];
    if (kind) return { kind, query: clean(match[2] || '', 120) };
    const query = match[2] || '';
    return { kind: inferKind(query) || (hasWord(query, 'متن') ? 'quote' : null), query: clean(query, 120) };
  }
  if (normalized.startsWith('/') || /نفرست|نمیخوام|نمیخواهم|نساز|بساز|تولید|شناسایی|اسم آهنگ|آهنگ.*چیه|خودکشی|خودآزاری|آسیب به خود/.test(normalized)) return null;
  if (!/بفرست|بده|بگو|پیشنهاد (?:کن|بده)|میخوام|میخواهم|داری[؟?]?/.test(normalized)) return null;
  if (/حرف بزن|صحبت|آهنگسازی|فیلمسازی|جملهبندی|نظرت|میخوام برم|میخواهم بروم/.test(normalized)) return null;
  if (/درباره|در مورد|معنی|تحلیل|ترجمه/.test(normalized) && !/بفرست|بده|داری/.test(normalized)) return null;
  const kind = inferKind(normalized);
  return kind ? { kind, query: clean(normalized, 120) } : null;
}

const stopWords = new Set('یه یک لطفا لطفاً برام برای من از به تو همون کانال چنل آهنگ موسیقی موزیک کلیپ ویدیو ویدئو فیلم جمله متن نقل قول بفرست بده بگو پیشنهاد کن بذار میخوام میخواهم داری این اون جدید دیگه دیگه؟ قشنگ خوب باحال بهم آهنگی کلیپی جملهای'.split(/\s+/));
const moods = [ ['غمگین', 'غم', 'دلتنگ', 'دلتنگی', 'دلگیر'], ['شاد', 'شادی', 'خوشحال'], ['آرام', 'آروم', 'آرامش'], ['انرژی', 'انرژیک', 'پرانرژی'], ['انگیزشی', 'انگیزه'], ['عاشقانه', 'عشق'], ['طنز', 'خنده', 'خندهدار'] ];
function terms(query) { return [...new Set(normalizeChannelText(query).split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !stopWords.has(w)))].slice(0, 16); }
export function selectChannelPost(rows, kind, query, exclude = []) {
  if (!['song', 'video', 'quote'].includes(kind)) return null;
  const words = terms(query), requestedMoods = moods.filter(group => words.some(w => group.includes(w)));
  const candidates = rows.filter(row => row.kind === kind && !row.unavailable && row.expiresAt > Date.now() && !exclude.includes(row.id)).map(row => {
    const haystack = normalizeChannelText([row.text, row.title, row.performer].join(' '));
    if (requestedMoods.some(group => !group.some(w => haystack.includes(w)))) return null;
    const score = words.reduce((n, word) => n + (haystack.includes(word) ? 1 : 0), 0);
    return { row, score };
  }).filter(Boolean);
  candidates.sort((a, b) => b.score - a.score || b.row.date - a.row.date || b.row.id - a.row.id);
  // Do not label an unrelated item as a match for a named song/topic.
  if (words.length && !candidates[0]?.score && !requestedMoods.length) return null;
  return candidates[0]?.row || null;
}

// Only literal positive weather interests trigger a conversational extra. Do not
// infer diagnoses, grief or a person's mood; ambiguous/negative contexts get none.
export function positiveWeatherContext(text) {
  const value = normalizeChannelText(text);
  if (value.startsWith('/') || /نفرست|نمیخوام|نمیخواهم|خودکشی|خودآزاری|بمیرم|بکشم|مرگ|سوگ|فوت|سیل|خسارت|تصادف|خطر|نگران|میترسم|دوست ندارم|دوستش ندارم|خوشم نمیاد|بدم میاد|متنفر|دردسر|کلافه|اذیت|حوصله ندارم|بدون آهنگ|بدون کلیپ|بدون پست/.test(value)) return null;
  if (!/دوست دارم|دوستش دارم|عاشق|حس خوب|ذوق|کیف|لذت|قشنگ/.test(value)) return null;
  const kind = hasWord(value, 'باران(?:ی|م)?|بارون(?:ی|م)?') ? 'rain' : hasWord(value, 'برف(?:ی|م)?') ? 'snow' : hasWord(value, 'ابری(?:ه)?|ابر(?:ها|های)?') ? 'cloud' : null;
  return kind ? { kind, severe: false } : null;
}
export function selectChannelMoment(rows, weather, exclude = []) {
  const topic = { rain: 'باران(?:ی)?|بارون(?:ی)?', snow: 'برف(?:ی)?', cloud: 'ابری|ابر(?:ها|های)?' }[weather];
  if (!topic) return null;
  return rows.filter(row => ['song', 'video', 'quote'].includes(row.kind) && !row.unavailable && row.expiresAt > Date.now() && !exclude.includes(row.id))
    .filter(row => {
      const text = normalizeChannelText([row.text, row.title, row.performer].join(' '));
      return hasWord(text, topic) && !/خودکشی|خودآزاری|سیل|خسارت|تصادف|هشدار|طوفان|توفان|بارش شدید|فوت|سوگ/.test(text);
    }).sort((a, b) => b.date - a.date || b.id - a.id)[0] || null;
}
export class ChannelLibraryHandler {
  constructor(ctx) { this.storage = ctx.storage; this.queue = Promise.resolve(); }
  lock(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  fetch(request) { return this.lock(() => this.handle(request)); }
  async read() { return (await this.storage.get('channelPosts') || []).filter(row => row.expiresAt > Date.now()).slice(-LIBRARY_LIMIT); }
  async save(rows) {
    // Schedule expiry before writing public excerpts. Never keep binaries/files.
    if (rows.length) await this.storage.setAlarm(Math.min(...rows.map(row => row.expiresAt)));
    else await this.storage.deleteAlarm();
    if (rows.length) await this.storage.put('channelPosts', rows);
    else await this.storage.delete('channelPosts');
  }
  alarm() { return this.lock(async () => { await this.save(await this.read()); }); }
  async handle(request) {
    const path = new URL(request.url).pathname, body = await request.json();
    let rows = await this.read();
    if (path === '/channel-update') {
      const post = body;
      if (!channelId(post.channelId) || !safeId(post.id) || !Number.isSafeInteger(post.version) || post.version < 0 || !safeId(post.date) || ![null, 'song', 'video', 'quote'].includes(post.kind)) return new Response('Invalid', { status: 400 });
      const old = rows.find(row => row.channelId === post.channelId && row.id === post.id);
      const revisionAt = safeId(post.revisionAt) ? post.revisionAt : post.date;
      if (!old || (old.revisionAt || old.date) < revisionAt || ((old.revisionAt || old.date) === revisionAt && old.version < post.version)) {
        rows = rows.filter(row => row !== old);
        const expiresAt = Math.min(post.date * 1000, Date.now()) + LIBRARY_TTL;
        if (expiresAt > Date.now()) rows.push({ channelId: post.channelId, id: post.id, version: post.version, revisionAt, date: post.date, kind: post.kind,
          text: post.kind ? clean(post.text) : '', title: post.kind ? clean(post.title, 100) : '', performer: post.kind ? clean(post.performer, 100) : '', expiresAt });
        rows.sort((a, b) => a.date - b.date || a.id - b.id); rows = rows.slice(-LIBRARY_LIMIT);
      }
      await this.save(rows); return Response.json({ ok: true });
    }
    if (!channelId(body.channelId)) return new Response('Invalid', { status: 400 });
    if (path === '/channel-find') {
      const scoped = rows.filter(row => row.channelId === body.channelId);
      const exclude = Array.isArray(body.exclude) ? body.exclude.slice(-10) : [];
      const row = body.kind === 'moment' ? selectChannelMoment(scoped, body.weather, exclude) : selectChannelPost(scoped, body.kind, clean(body.query, 120), exclude);
      return Response.json({ value: row });
    }
    if (path === '/channel-get' || path === '/channel-invalidate') {
      const row = rows.find(row => row.channelId === body.channelId && row.id === body.id && row.kind && !row.unavailable);
      if (path === '/channel-invalidate' && row?.version === body.version && row.revisionAt === body.revisionAt) { row.unavailable = true; await this.save(rows); }
      return Response.json({ value: path === '/channel-get' ? row || null : null });
    }
    return new Response('Not found', { status: 404 });
  }
}

export const nextChannelOffer = record => Math.min(...(record?.channelOffers || []).map(row => row.expiresAt));

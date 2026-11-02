import { complete, splitMessage, PERSONA_GREETING, HISTORY_LIMIT, START_GREETING, OUTREACH_NOTICE } from './core.mjs';
import { handleSetup } from './setup.mjs';
import { formatReply } from './format.mjs';
import { WeatherAssistant, nextWeatherWake } from './weather-assistant.mjs';
import { isMarketQuestion, isWeatherQuestion } from './live-data.mjs';

const TTL = 30 * 60_000;
export const FOLLOWUP_NOTICE = OUTREACH_NOTICE;
export const FOLLOWUP_DELAY = 24 * 60 * 60_000;
export const FOLLOWUP_TEXT = 'سلام رفیق، امروز چطوری؟ 🙂🌱\n\nلغو احوال‌پرسی: /stop';
export const CLOUD_PRIVACY = 'پیام‌ها برای پاسخ به OpenRouter و ارائه‌دهندهٔ مدل ارسال می‌شن. حداکثر ۳۰ پیام اخیر در کلودفلر نگه داشته و بعد از ۳۰ دقیقه بی‌فعالیتی یا /reset از حافظهٔ فعال حذف می‌شن. احوال‌پرسی پس از اطلاع کوتاه در گفتگو خودکار فعاله؛ حدود ۲۴ ساعت بعد از آخرین پیام، یک پیام عمومی می‌فرستیم، نه پیام تکراری روزانه. لغو: /stop — فعال‌سازی دوباره: /followup. شناسهٔ چت و زمان ارسال جدا از متن گفتگو ذخیره می‌شن؛ با لغو، این دو حذف و فقط ترجیح خاموشی نگه داشته می‌شه تا با پیام جدید یا /start دوباره فعال نشه. /reset هم پیگیری رو خاموش می‌کنه. پیام‌های تلگرام، داده‌های سرویس مدل و نسخه‌های پشتیبان تابع سیاست همون سرویس‌ها هستن. شهر پیش‌فرض آباده، فارس است، نه لزوماً محل زندگی تو. پیام‌های خودکار بعد از اطلاع کلیِ پیام‌دادن فعال می‌شن. جملهٔ همراه خبر هوا با OpenRouter تولید می‌شه؛ اگر گفتگوی تازه‌ای باشه، فقط یک نشانهٔ کلی برای ملایم‌ترشدن لحن به‌صورت محلی گرفته می‌شه؛ متن خصوصی گفتگو در درخواست نوشتن جمله فرستاده نمی‌شه. شهر دلخواه و مختصات تقریبی آن جداگانه برای هوا نگه داشته و به Open-Meteo ارسال می‌شه؛ حذف شهر و هشدارها: /forgetcity یا /reset. ترجیح خاموشی هوا هم جدا نگه داشته می‌شه تا با پیام جدید دوباره فعال نشه. /stop همهٔ پیام‌های خودکار رو خاموش می‌کنه. زمان درخواست تست برف فقط برای محدودکردن مصرف تا یک ساعت نگه داشته می‌شه. لطفاً اطلاعات حساس نفرست.';
const ABOUT = `${PERSONA_GREETING}\n\n${CLOUD_PRIVACY}\n\nلغو احوال‌پرسی: /stop — فعال‌سازی دوباره: /followup\n\nاین روزها مشغول چه کاری هستی و کجاش گیر کردی؟`;
const FAILURE = 'الان نتونستم پاسخ رو آماده یا ارسال کنم. لطفاً کمی بعد دوباره پیام بده. اگر در خطر فوری هستی، منتظر ربات نمون و با خدمات اضطراری محل یا یک فرد مطمئن تماس بگیر.';
const ok = () => new Response('OK');

// Bounded streaming read: never buffer an arbitrarily large webhook request.
async function readUpdate(request) {
  if (!request.body) throw new Error('Empty body');
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) { await reader.cancel(); throw new Error('Body too large'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createWorker() {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/') return new Response('Telegram support bot');
      if (url.pathname === '/setup') return handleSetup(request, env);
      if (url.pathname !== '/webhook') return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL || !env.TELEGRAM_ALLOWED_USER_IDS?.trim()) {
        return new Response('Bot not configured', { status: 503 });
      }
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      let update;
      try { update = await readUpdate(request); }
      catch { return new Response('Invalid update', { status: 400 }); }
      if (!Number.isSafeInteger(update?.update_id)) return new Response('Invalid update', { status: 400 });
      const message = update.message;
      if (!message?.from || message.from.is_bot || message.chat?.type !== 'private') return ok();
      if (!Number.isSafeInteger(message.from.id) || !Number.isSafeInteger(message.chat.id) || message.from.id !== message.chat.id) return ok();
      const allowed = env.TELEGRAM_ALLOWED_USER_IDS.trim();
      if (allowed !== '*' && !allowed.split(',').map(s => s.trim()).includes(String(message.from.id))) return ok();
      const objectId = env.CHATS.idFromName(String(message.from.id));
      try {
        return await env.CHATS.get(objectId).fetch('https://chat.internal/update', {
          method: 'POST', body: JSON.stringify(update),
        });
      } catch {
        // Never log exception objects: fetch errors may contain token-bearing URLs.
        return new Response('Temporarily unavailable', { status: 503 });
      }
    },
  };
}

export default createWorker();

// One object per private chat isolates history and serializes simultaneous messages.
// No waitUntil: keep the webhook request open until processing finishes, so an
// acknowledged update is not abandoned at the background execution deadline.
export class ChatSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.weather = new WeatherAssistant(ctx.storage, env, (chat, text) => this.send(chat, text), () => this.scheduleAlarm());
  }
  fetch(request) {
    const task = this.queue.then(async () => this.process(await request.json()));
    this.queue = task.catch(() => {});
    return task;
  }
  alarm() {
    const task = this.queue.then(async () => {
      const record = await this.ctx.storage.get('session');
      if (record && record.expiresAt <= Date.now()) await this.ctx.storage.delete('session');
      const followup = await this.ctx.storage.get('followup');
      if (followup?.dueAt && !followup.disabled && followup.dueAt <= Date.now()) {
        // Claim before sending: retries/duplicate alarms must not spam users.
        // A crash after this write can lose the check-in; delivery isn't exactly-once.
        followup.dueAt = null;
        await this.ctx.storage.put('followup', followup);
        const allowed = this.env.TELEGRAM_ALLOWED_USER_IDS?.trim() || '';
        if (allowed === '*' || allowed.split(',').map(s => s.trim()).includes(String(followup.chatId))) {
          try { await this.send(followup.chatId, FOLLOWUP_TEXT); }
          catch { await this.disableFollowup(); } // blocked bot, unavailable API, etc.
        } else {
          await this.disableFollowup();
        }
      }
      await this.weather.alarm();
      await this.scheduleAlarm();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async scheduleAlarm() {
    const record = await this.ctx.storage.get('session');
    const followup = await this.ctx.storage.get('followup');
    const weather = await this.ctx.storage.get('weather');
    const preview = await this.ctx.storage.get('snowPreview');
    const times = [record?.expiresAt, (followup?.disabled ? null : followup?.dueAt), nextWeatherWake(weather), preview?.expiresAt].filter(time => Number.isFinite(time) && time > 0);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
  async armFollowup(chatId, record) {
    const followup = { chatId, dueAt: Date.now() + FOLLOWUP_DELAY, noticeShown: true, disabled: false };
    const weather = await this.ctx.storage.get('weather');
    const preview = await this.ctx.storage.get('snowPreview');
    await this.ctx.storage.setAlarm(Math.min(record.expiresAt, followup.dueAt, nextWeatherWake(weather) || Infinity, preview?.expiresAt || Infinity));
    await this.ctx.storage.put('followup', followup);
  }
  async disableFollowup() {
    // Keep only the opt-out preference; no chat ID, deadline or transcript.
    // Deleting this key would silently re-enable follow-ups on the next message.
    await this.ctx.storage.put('followup', { disabled: true, noticeShown: true, dueAt: null });
  }
  async greet(chat, record) {
    const preference = await this.ctx.storage.get('followup');
    const needsNotice = !preference?.disabled && !preference?.noticeShown;
    await this.send(chat, needsNotice ? `${START_GREETING}\n\n${FOLLOWUP_NOTICE}` : START_GREETING);
    if (!preference?.disabled) {
      await this.armFollowup(chat, record);
      await this.weather.ensureAutomatic(chat, needsNotice);
    }
  }
  async ensureAutomaticFollowup(chat, record) {
    const preference = await this.ctx.storage.get('followup');
    if (preference?.disabled) return;
    // Deliver the disclosure before enabling automatic outreach. Existing
    // opt-in subscriptions remain valid, but are informed on their next chat.
    if (!preference?.noticeShown) await this.send(chat, FOLLOWUP_NOTICE);
    await this.armFollowup(chat, record);
    await this.weather.ensureAutomatic(chat, !preference?.noticeShown);
  }
  async telegram(method, body) {
    const fetchImpl = this.env.fetchImpl || fetch;
    const response = await fetchImpl(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    if (!response.ok || !(await response.json()).ok) throw new Error('Telegram delivery failed');
  }
  async send(chat, text) {
    for (const part of splitMessage(text)) await this.telegram('sendMessage', { chat_id: chat, text: part });
  }
  async sendReply(chat, text) {
    const payloads = formatReply(text);
    if (!payloads.length) throw new Error('Empty formatted reply');
    for (const payload of payloads) await this.telegram('sendMessage', { chat_id: chat, ...payload });
  }
  async persist(record) {
    // Set the cleanup alarm before writing sensitive data; a failed write leaves
    // only a harmless alarm, not stored data with no scheduled cleanup.
    const followup = await this.ctx.storage.get('followup');
    const weather = await this.ctx.storage.get('weather');
    const preview = await this.ctx.storage.get('snowPreview');
    await this.ctx.storage.setAlarm(Math.min(record.expiresAt, (followup?.disabled ? Infinity : followup?.dueAt || Infinity), nextWeatherWake(weather) || Infinity, preview?.expiresAt || Infinity));
    await this.ctx.storage.put('session', record);
  }
  async process(update) {
    let record = await this.ctx.storage.get('session');
    if (!record || record.expiresAt <= Date.now()) record = { messages: [], seen: [], lastAt: 0, introduced: false };
    if (record.seen.includes(update.update_id)) return ok();
    // Reserve before external calls. This is at-most-once within the retention
    // window: a crash can lose a reply, but a Telegram retry won't double-charge.
    record.seen = [...record.seen, update.update_id].slice(-100);
    record.expiresAt = Date.now() + TTL;
    await this.persist(record);
    const { message } = update;
    const chat = message.chat.id;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const command = text.split(/\s/)[0].split('@')[0].toLowerCase();
    try {
      if (command === '/reset' || command === '/start') {
        if (command === '/reset') {
          await this.disableFollowup();
          await this.weather.stop(true);
        }
        record.messages = [];
        record.lastAt = 0;
        record.introduced = command === '/start';
        await this.persist(record);
        if (command === '/start') await this.greet(chat, record);
        else await this.send(chat, 'سابقهٔ فعال و شهر پاک شد؛ همهٔ پیام‌های خودکار خاموش شد 🌱 پیام‌های تلگرام و سرویس مدل پاک نمی‌شن.');
        return ok();
      }
      if (command === '/followup') {
        await this.armFollowup(chat, record);
        await this.send(chat, 'فعالش کردم 🌱⏰ حدود ۲۴ ساعت بعد از آخرین پیام متنیت، یک بار احوالت رو می‌پرسم 🙂 با پیام جدید زمان از نو حساب می‌شه. لغو: /stop');
        return ok();
      }
      if (command === '/stop') {
        await this.disableFollowup();
        await this.weather.stop();
        await this.scheduleAlarm();
        await this.send(chat, 'همهٔ پیام‌های خودکار خاموش شد ✅🌱 احوال‌پرسی: /followup — هشدار هوا: /alerts');
        return ok();
      }
      if (command === '/about') { await this.send(chat, ABOUT); return ok(); }
      if (command === '/privacy') { await this.send(chat, CLOUD_PRIVACY); return ok(); }
      if (command === '/help') {
        await this.send(chat, '/start سلام و شروع دوباره\n/about دربارهٔ امیر\n/reset پاک‌کردن حافظهٔ فعال گفتگو\n/privacy حریم خصوصی\n/followup فعال‌سازی دوبارهٔ احوال‌پرسی\n/stop لغو همهٔ پیام‌های خودکار\n/prices قیمت دلار و طلا\n/city نام شهر\n/weather وضعیت هوا\n/test_snow تست شخصی برف (آزمایشی)\n/alerts فعال‌کردن هشدار بارش\n/weatherstop خاموش‌کردن هشدار هوا\n/forgetcity حذف شهر\n\nفقط متن در چت خصوصی. من هوش مصنوعی‌ام و جایگزین درمانگر یا خدمات اضطراری نیستم.');
        return ok();
      }
      if (command === '/test_snow') {
        await this.weather.previewSnow(chat);
        return ok();
      }
      if (command === '/weatherstop' || command === '/forgetcity') {
        await this.weather.handle(text, chat);
        return ok();
      }
      if (!text) { await this.send(chat, 'فعلاً فقط پیام متنی رو می‌تونم بخونم 🌱'); return ok(); }
      if (text.length > 6000) { await this.send(chat, 'لطفاً پیامت رو به بخش‌های کمتر از ۶۰۰۰ کاراکتر تقسیم کن.'); return ok(); }
      const wantsPrices = command === '/prices' || isMarketQuestion(text);
      const wantsWeather = ['/city', '/weather', '/alerts'].includes(command) || isWeatherQuestion(text);
      if (wantsPrices || wantsWeather) {
        if (Date.now() - (record.lastLiveAt || 0) < 4000) {
          await this.send(chat, 'برای دریافت دادهٔ تازه چند ثانیه صبر کن 🌱');
          return ok();
        }
        record.lastLiveAt = Date.now();
        await this.persist(record);
        if (wantsPrices) {
          try {
            const id = this.env.MARKETS.idFromName('iran-market');
            const response = await this.env.MARKETS.get(id).fetch('https://market.internal/latest');
            await this.send(chat, await response.text());
          } catch {
            await this.send(chat, 'الان منبع قیمت در دسترس نیست؛ قیمت حدسی نمی‌گم 🌱');
          }
        } else {
          await this.weather.handle(text, chat);
        }
        return ok();
      }
      if (Date.now() - record.lastAt < 4000) { await this.send(chat, 'لطفاً چند ثانیه صبر کن و دوباره پیام بده.'); return ok(); }
      record.lastAt = Date.now();
      await this.persist(record);
      if (!record.introduced) {
        await this.greet(chat, record);
        record.introduced = true;
        await this.persist(record);
      } else {
        await this.ensureAutomaticFollowup(chat, record);
      }
      const messages = [...record.messages, { role: 'user', content: text }];
      const answer = await complete({
        apiKey: this.env.OPENROUTER_API_KEY, model: this.env.OPENROUTER_MODEL,
        style: this.env.BOT_STYLE, messages,
        fetchImpl: this.env.fetchImpl || fetch, timeoutMs: 20_000,
      });
      await this.sendReply(chat, answer);
      record.messages = [...messages, { role: 'assistant', content: answer }].slice(-HISTORY_LIMIT);
      record.expiresAt = Date.now() + TTL;
      await this.persist(record);
    } catch {
      // Update is reserved even when provider/delivery fails. User can send a new
      // message; do not retry blindly and incur additional OpenRouter charges.
      try { await this.send(chat, FAILURE); } catch { /* No sensitive logs. */ }
    }
    return ok();
  }
}

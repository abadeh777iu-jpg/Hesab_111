import { MembershipGate, membershipRequired, JOIN_CALLBACK, JOIN_KEYBOARD, JOIN_TEXT, JOIN_UNAVAILABLE, enableMembershipCallbacks } from './membership.mjs';
import { CREATOR_REPLY, isCreatorQuestion } from './creator.mjs';
import { complete, splitMessage, PERSONA_GREETING, HISTORY_LIMIT, START_GREETING, OUTREACH_NOTICE } from './core.mjs';
import { handleSetup } from './setup.mjs';
import { formatReply } from './format.mjs';
import { WeatherAssistant, nextWeatherWake } from './weather-assistant.mjs';
import { isCalendarQuestion, iranToday, calendarReply } from './calendar.mjs';
import { isMarketQuestion, isWeatherQuestion } from './live-data.mjs';
import { isNewsQuestion, newsReply, newsFailureMessage, NEWS_UNAVAILABLE } from './news.mjs';
import { parseMediaRequest, validateMediaConfiguration, PERSONAL_MEDIA_LIMITS, nextMediaDay, generateImage, generateSpeech, uploadMedia, mediaFailureMessage } from './media.mjs';

const TTL = 30 * 60_000;
export const FOLLOWUP_NOTICE = OUTREACH_NOTICE;
export const FOLLOWUP_DELAY = 24 * 60 * 60_000;
export const FOLLOWUP_TEXT = 'سلام رفیق، امروز چطوری؟ 🙂🌱\n\nلغو احوال‌پرسی: /stop';
export const CLOUD_PRIVACY = 'پیام‌ها برای پاسخ به OpenRouter و ارائه‌دهندهٔ مدل ارسال می‌شن. حداکثر ۳۰ پیام اخیر در کلودفلر نگه داشته و بعد از ۳۰ دقیقه بی‌فعالیتی یا /reset از حافظهٔ فعال حذف می‌شن. احوال‌پرسی پس از اطلاع کوتاه در گفتگو خودکار فعاله؛ حدود ۲۴ ساعت بعد از آخرین پیام، یک پیام عمومی می‌فرستیم، نه پیام تکراری روزانه. لغو: /stop — فعال‌سازی دوباره: /followup. شناسهٔ چت و زمان ارسال جدا از متن گفتگو ذخیره می‌شن؛ با لغو، این دو حذف و فقط ترجیح خاموشی نگه داشته می‌شه تا با پیام جدید یا /start دوباره فعال نشه. /reset هم پیگیری رو خاموش می‌کنه. پیام‌های تلگرام، داده‌های سرویس مدل و نسخه‌های پشتیبان تابع سیاست همون سرویس‌ها هستن. شهر پیش‌فرض آباده، فارس است، نه لزوماً محل زندگی تو. پیام‌های خودکار بعد از اطلاع کلیِ پیام‌دادن فعال می‌شن. جملهٔ همراه خبر هوا با OpenRouter تولید می‌شه؛ اگر گفتگوی تازه‌ای باشه، فقط یک نشانهٔ کلی برای ملایم‌ترشدن لحن به‌صورت محلی گرفته می‌شه؛ متن خصوصی گفتگو در درخواست نوشتن جمله فرستاده نمی‌شه. شهر دلخواه و مختصات تقریبی آن جداگانه برای هوا نگه داشته و به Open-Meteo ارسال می‌شه؛ حذف شهر و هشدارها: /forgetcity یا /reset. ترجیح خاموشی هوا هم جدا نگه داشته می‌شه تا با پیام جدید دوباره فعال نشه. /stop همهٔ پیام‌های خودکار رو خاموش می‌کنه. زمان درخواست تست برف فقط برای محدودکردن مصرف تا یک ساعت نگه داشته می‌شه. چت و نوشتن پاسخ روی OpenRouter می‌مونه. برای عکس، توضیح درخواستی به Free.ai و مدل تصویر فرستاده می‌شه؛ برای ویس، فقط متن پاسخ به سرویس صدای OpenRouter و ارائه‌دهندهٔ مدل گفتار فرستاده می‌شه؛ اگر مدیر آگاهانه سرویس رسانه رو عوض کنه، مقصد همان سرویس انتخابی می‌شه. فایل خروجی Free.ai ممکنه تا مدتی روی آدرس عمومی سرویس در دسترس باشه و سیاست نگهداری خودش اعمال می‌شه؛ فایل ساخته‌شده به تلگرام ارسال می‌شه ولی این برنامه فایل رو ذخیره یا لاگ نمی‌کنه. ویس صدای مصنوعیه، نه صدای واقعی امیر. بودجهٔ مصرف عکس و ویس بدون متن یا فایل تا پایان روز UTC نگه داشته می‌شه؛ /reset این محدودیت مصرف رو پاک نمی‌کنه. اخبار ایران فقط با سؤال تو از خوراک عمومی ایسنا، بی‌بی‌سی فارسی، صداوسیما و فاکس‌نیوز و صفحهٔ عمومی کانال فارس دریافت می‌شه؛ متن خصوصی یا کلیدت به رسانه‌ها نمی‌ره. فقط تیتر و خلاصهٔ خبرها برای بازنویسی به OpenRouter می‌ره و از اعتبار مدیر استفاده می‌کنه؛ این خلاصه، تأیید مستقل گزارش رسانه نیست. دریافت خبرها تا یک دقیقه مشترک cache می‌شه؛ در قطع منبع، آخرین داده با برچسب ذخیره‌شده و فقط تا ۲۴ ساعت از انتشار قابل نمایشه. پیام خبری خودکار نداریم. تاریخ و روز هفته به وقت ایران از ساعت برنامه محاسبه می‌شه؛ مناسبت‌های ثابت محلی‌اند و تعطیلات از تقویم عمومی ایران گوگل، بدون شناسه یا پیام خصوصی، دریافت و مشترک ذخیره می‌شن. پاسخ تقویم از OpenRouter اعتبار مصرف نمی‌کنه و اعلان روزانهٔ تازه‌ای فعال نمی‌کنه. برای چت، عضویت در کانال @qhatel_roya با شناسهٔ تلگرام و از طریق خود تلگرام بررسی می‌شه؛ متن پیام برای کانال فرستاده نمی‌شه و نتیجهٔ عضویت دائماً ذخیره نمی‌شه. خروج از کانال، دسترسی چت و پیام‌های خودکار رو تا عضویت مجدد محدود می‌کنه. /stop و /reset و فرمان‌های حریم خصوصی بدون عضویت هم در دسترس‌اند. لطفاً اطلاعات حساس نفرست.';
const ABOUT = `${PERSONA_GREETING}\n\n${CREATOR_REPLY}\n\n${CLOUD_PRIVACY}\n\nلغو احوال‌پرسی: /stop — فعال‌سازی دوباره: /followup\n\nاین روزها مشغول چه کاری هستی و کجاش گیر کردی؟`;
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
      const callback = update.callback_query;
      if (callback && (update.message || callback.data !== JOIN_CALLBACK || typeof callback.id !== 'string' || !callback.id.length || callback.id.length > 256 || (!Number.isSafeInteger(callback.message?.message_id) || callback.message.message_id <= 0))) return ok();
      const message = callback ? { ...callback.message, from: callback.from } : update.message;
      if (!message?.from || message.from.is_bot || message.chat?.type !== 'private') return ok();
      if (!Number.isSafeInteger(message.from.id) || !Number.isSafeInteger(message.chat.id) || message.from.id <= 0 || message.from.id !== message.chat.id) return ok();
      const allowed = env.TELEGRAM_ALLOWED_USER_IDS.trim();
      if (allowed !== '*' && !allowed.split(',').map(s => s.trim()).includes(String(message.from.id))) return ok();
      const objectId = env.CHATS.idFromName(String(message.from.id));
      try {
        return await env.CHATS.get(objectId).fetch('https://chat.internal/update', {
          method: 'POST', body: JSON.stringify({ ...update, webhookURL: url.origin + '/webhook' }),
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
    this.membership = new MembershipGate((method, body) => this.telegram(method, body));
    this.callbackSetupAt = 0;
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
          try {
            if (!membershipRequired(this.env) || await this.membership.check(followup.chatId) === 'member') await this.send(followup.chatId, FOLLOWUP_TEXT);
          }
          catch { await this.disableFollowup(); } // blocked bot, unavailable API, etc.
        } else {
          await this.disableFollowup();
        }
      }
      const mediaUsage = await this.ctx.storage.get('mediaUsage');
      if (mediaUsage?.expiresAt <= Date.now()) await this.ctx.storage.delete('mediaUsage');
      const weather = await this.ctx.storage.get('weather');
      if (weather?.alertsEnabled && weather.nextCheckAt <= Date.now() && membershipRequired(this.env) && await this.membership.check(weather.chatId) !== 'member') {
        // Pause paid weather prose while outside the channel or Telegram is down;
        // preserve the user's existing subscription and explicit opt-out choices.
        await this.ctx.storage.put('weather', { ...weather, nextCheckAt: Date.now() + 60 * 60_000 });
      } else await this.weather.alarm();
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
    const mediaUsage = await this.ctx.storage.get('mediaUsage');
    const times = [record?.expiresAt, (followup?.disabled ? null : followup?.dueAt), nextWeatherWake(weather), preview?.expiresAt, mediaUsage?.expiresAt].filter(time => Number.isFinite(time) && time > 0);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
  async armFollowup(chatId, record) {
    const followup = { chatId, dueAt: Date.now() + FOLLOWUP_DELAY, noticeShown: true, disabled: false };
    const weather = await this.ctx.storage.get('weather');
    const preview = await this.ctx.storage.get('snowPreview');
    const mediaUsage = await this.ctx.storage.get('mediaUsage');
    await this.ctx.storage.setAlarm(Math.min(record.expiresAt, followup.dueAt, nextWeatherWake(weather) || Infinity, preview?.expiresAt || Infinity, mediaUsage?.expiresAt || Infinity));
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
    if (!response.ok) throw new Error('Telegram delivery failed');
    const data = await response.json();
    if (!data.ok) throw new Error('Telegram delivery failed');
    return data.result;
  }
  async send(chat, text) {
    for (const part of splitMessage(text)) await this.telegram('sendMessage', { chat_id: chat, text: part });
  }
  async showMembershipGate(chat, status) {
    await this.telegram('sendMessage', { chat_id: chat, text: status === 'unavailable' ? JOIN_UNAVAILABLE : JOIN_TEXT,
      reply_markup: JOIN_KEYBOARD, link_preview_options: { is_disabled: true } });
  }
  async prepareMembershipButtons(webhookURL) {
    if (Date.now() - this.callbackSetupAt < 15 * 60_000) return;
    this.callbackSetupAt = Date.now();
    try { await enableMembershipCallbacks((method, body) => this.telegram(method, body), webhookURL, this.env.TELEGRAM_WEBHOOK_SECRET); }
    catch { /* Membership still fails closed; /start remains a working fallback. */ }
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
    const mediaUsage = await this.ctx.storage.get('mediaUsage');
    await this.ctx.storage.setAlarm(Math.min(record.expiresAt, (followup?.disabled ? Infinity : followup?.dueAt || Infinity), nextWeatherWake(weather) || Infinity, preview?.expiresAt || Infinity, mediaUsage?.expiresAt || Infinity));
    await this.ctx.storage.put('session', record);
  }
  async reserveMedia(kind) {
    const now = Date.now();
    let usage = await this.ctx.storage.get('mediaUsage');
    if (!usage || usage.expiresAt <= now) usage = { image: 0, voice: 0, expiresAt: nextMediaDay(now), lastAt: null };
    if (usage[kind] >= PERSONAL_MEDIA_LIMITS[kind]) return 'سهمیهٔ امروزت تموم شده 🌱 هر نفر روزی پنج عکس و سه ویس می‌تونه درخواست کنه؛ سهمیه در نیمه‌شب UTC نو می‌شه.';
    if (usage.lastAt !== null && now - usage.lastAt < 60_000) return 'بین درخواست عکس و ویس یک دقیقه فاصله بذار 🌱';
    const id = this.env.MEDIA.idFromName('media-budget');
    const grant = await this.env.MEDIA.get(id).fetch('https://media.internal/reserve', {
      method: 'POST', body: JSON.stringify({ kind }),
    });
    if (grant.status === 429) return 'سهمیهٔ امروزِ کل ربات تموم شده 🌱 برای کنترل هزینه، روزی حداکثر ده عکس و ده ویس برای همهٔ مخاطب‌ها داریم.';
    if (!grant.ok) throw new Error('Media budget unavailable');
    usage[kind]++;
    usage.lastAt = now;
    // Cleanup alarm before writing; /reset and expiring history cannot bypass it.
    await this.ctx.storage.setAlarm(Math.min(now + TTL, usage.expiresAt));
    await this.ctx.storage.put('mediaUsage', usage);
    await this.scheduleAlarm();
    return null;
  }
  async handleMedia(chat, request, record) {
    const { kind, prompt } = request;
    if (this.env.MEDIA_ENABLED === 'false' || !this.env.MEDIA) {
      await this.send(chat, 'ساخت عکس و ویس فعلاً فعال نیست 🌱'); return;
    }
    if (prompt.length > 2000) {
      await this.send(chat, 'برای عکس یا ویس، توضیحت رو کوتاه‌تر از ۲۰۰۰ کاراکتر بفرست 🌱'); return;
    }
    const previous = [...record.messages].reverse().find(message => message.role === 'assistant')?.content;
    if ((kind === 'image' && !prompt) || (kind === 'voice' && !prompt && !previous)) {
      await this.send(chat, kind === 'image'
        ? 'چی برات بسازم؟ 🎨 مثلاً: /image یه کلبه وسط برف'
        : 'برای ویس، سؤالت رو بنویس 🎙️ مثلاً: /voice چطور کارمو شروع کنم؟\nیا بعد از جواب متنی، /voice بفرست. صدای مصنوعیه، نه صدای واقعی امیر.');
      return;
    }
    try {
      validateMediaConfiguration(this.env, kind);
      const denied = await this.reserveMedia(kind);
      if (denied) { await this.send(chat, denied); return; }
      if (kind === 'image') {
        await this.send(chat, 'دارم عکست رو می‌سازم 🎨✨ ممکنه کمی طول بکشه.');
        await uploadMedia(this.env, chat, kind, await generateImage(this.env, prompt));
      } else {
        let answer = previous;
        if (prompt) {
          const messages = [...record.messages, { role: 'user', content: prompt }];
          answer = await complete({
            apiKey: this.env.OPENROUTER_API_KEY, model: this.env.OPENROUTER_MODEL,
            style: this.env.BOT_STYLE, messages,
            fetchImpl: this.env.fetchImpl || fetch, timeoutMs: 20_000,
          });
          // Keep the readable answer even if synthesis or delivery later fails.
          await this.sendReply(chat, answer);
          record.messages = [...messages, { role: 'assistant', content: answer }].slice(-HISTORY_LIMIT);
          record.expiresAt = Date.now() + TTL;
          await this.persist(record);
        }
        await uploadMedia(this.env, chat, kind, await generateSpeech(this.env, answer));
      }
    } catch (error) {
      // No raw upstream errors, bodies, prompts, files or token-bearing URLs.
      await this.send(chat, mediaFailureMessage(error));
    }
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
    const callback = update.callback_query;
    const message = callback ? { ...callback.message, from: callback.from } : update.message;
    const chat = message.chat.id;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const command = text.split(/\s/)[0].split('@')[0].toLowerCase();
    try {
      if (callback) {
        await this.telegram('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
        const status = membershipRequired(this.env) ? await this.membership.check(chat) : 'member';
        if (status === 'member') {
          await this.telegram('editMessageReplyMarkup', { chat_id: chat, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await this.send(chat, 'عضویتت تأیید شد ✅🌱 حالا پیامت رو بفرست تا گپ بزنیم.');
        } else await this.showMembershipGate(chat, status);
        return ok();
      }
      // Privacy, cancellation and public contact remain available without joining.
      const gateExempt = ['/stop', '/reset', '/privacy', '/about', '/help', '/weatherstop', '/forgetcity'].includes(command) || isCreatorQuestion(text);
      if (membershipRequired(this.env) && !gateExempt) {
        await this.prepareMembershipButtons(update.webhookURL);
        const status = await this.membership.check(chat);
        if (status !== 'member') { await this.showMembershipGate(chat, status); return ok(); }
      }
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
        await this.send(chat, '/start سلام و شروع دوباره\n/about دربارهٔ امیر\n/creator ارتباط با سازنده\n/reset پاک‌کردن حافظهٔ فعال گفتگو\n/privacy حریم خصوصی\n/followup فعال‌سازی دوبارهٔ احوال‌پرسی\n/stop لغو همهٔ پیام‌های خودکار\n/image توضیح عکس دلخواه\n/voice سؤال یا خواندن پاسخ قبلی با صدای مصنوعی\n/date تاریخ، روز هفته و مناسبت‌های ثبت‌شده\n/prices قیمت دلار و طلا\n/news یا «چه خبر؟» اخبار ایران\n/city نام شهر\n/weather وضعیت هوا\n/test_snow تست شخصی برف (آزمایشی)\n/alerts فعال‌کردن هشدار بارش\n/weatherstop خاموش‌کردن هشدار هوا\n/forgetcity حذف شهر\n\nورودی فقط متن در چت خصوصی؛ عکس و ویس فقط با درخواست خودت، از اعتبار مدیر و با سقف مصرف. هر نفر روزی پنج عکس و سه ویس؛ کل ربات ده عکس و ده ویس (روز UTC). صدای ویس مصنوعیه. من هوش مصنوعی‌ام و جایگزین درمانگر یا خدمات اضطراری نیستم.');
        return ok();
      }
      if (isCreatorQuestion(text)) {
        await this.send(chat, CREATOR_REPLY);
        record.messages = [...record.messages, { role: 'user', content: text }, { role: 'assistant', content: CREATOR_REPLY }].slice(-HISTORY_LIMIT);
        record.expiresAt = Date.now() + TTL;
        await this.persist(record);
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
      const mediaRequest = parseMediaRequest(text);
      if (mediaRequest) {
        await this.handleMedia(chat, mediaRequest, record);
        return ok();
      }
      if (isCalendarQuestion(text)) {
        if (Date.now() - (record.lastLiveAt || 0) < 4000) {
          await this.send(chat, 'چند ثانیه صبر کن، دوباره تقویم رو می‌گم 🌱');
          return ok();
        }
        record.lastLiveAt = Date.now();
        await this.persist(record);
        let answer;
        try {
          const id = this.env.MARKETS.idFromName('iran-calendar');
          const response = await this.env.MARKETS.get(id).fetch('https://market.internal/calendar');
          if (!response.ok) throw new Error('Calendar unavailable');
          answer = await response.text();
        } catch { answer = calendarReply(iranToday()); }
        await this.send(chat, answer);
        record.messages = [...record.messages, { role: 'user', content: text }, { role: 'assistant', content: answer }].slice(-HISTORY_LIMIT);
        record.expiresAt = Date.now() + TTL;
        await this.persist(record);
        return ok();
      }
      if (isNewsQuestion(text)) {
        if (Date.now() - Math.max(record.lastAt || 0, record.lastLiveAt || 0) < 4000) {
          await this.send(chat, 'برای خبر تازه چند ثانیه صبر کن 🌱');
          return ok();
        }
        record.lastAt = record.lastLiveAt = Date.now();
        await this.persist(record);
        let items, newsMetadata;
        try {
          const id = this.env.MARKETS.idFromName('iran-news');
          const response = await this.env.MARKETS.get(id).fetch('https://market.internal/news');
          if (!response.ok) throw new Error('No fresh news');
          newsMetadata = await response.json();
          items = newsMetadata.items;
          if (!Array.isArray(items) || !items.length || items.length > 2) throw new Error('Bad news data');
        } catch {
          await this.send(chat, NEWS_UNAVAILABLE);
          return ok();
        }
        let html;
        try { html = await newsReply(this.env, items, newsMetadata); }
        catch (error) {
          await this.send(chat, newsFailureMessage(error));
          return ok();
        }
        await this.telegram('sendMessage', { chat_id: chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        record.messages = [...record.messages, { role: 'user', content: text },
          { role: 'assistant', content: html.replace(/<[^>]*>/g, '') }].slice(-HISTORY_LIMIT);
        record.expiresAt = Date.now() + TTL;
        await this.persist(record);
        return ok();
      }
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

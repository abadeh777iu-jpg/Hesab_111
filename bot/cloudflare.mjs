import { automaticChannelPosts, positiveWeatherContext, AUTO_POST_INTERVAL, compactChannelPost, channelRequest, channelKindLabel, isChannelCallback, nextChannelOffer, OFFER_TTL, LIBRARY_CHANNEL } from './channel-library.mjs';
import { DurableInbox, asyncUpdates, compactUpdate, nextInboxWake, priorityUpdate, BUSY_TEXT, EXPIRED_TEXT } from './load-control.mjs';
import { instagramRequest, isMusicCallback, InstagramError, instagramFailure, IG_PERSONAL_LIMIT, IG_JOB_TTL, nextInstagramJob, igDayEnd, downloadInstagramVideo, uploadInstagramVideo, musicReply } from './instagram.mjs';
import { MembershipGate, membershipRequired, JOIN_CALLBACK, JOIN_KEYBOARD, JOIN_TEXT, JOIN_UNAVAILABLE, enableMembershipCallbacks } from './membership.mjs';
import { CREATOR_REPLY, isCreatorQuestion } from './creator.mjs';
import { complete, splitMessage, PERSONA_GREETING, HISTORY_LIMIT, START_GREETING, OUTREACH_NOTICE } from './core.mjs';
import { handleSetup } from './setup.mjs';
import { formatReply } from './format.mjs';
import { WeatherAssistant, nextWeatherWake } from './weather-assistant.mjs';
import { isCalendarQuestion, iranToday, calendarReply } from './calendar.mjs';
import { isMarketQuestion, isWeatherQuestion } from './live-data.mjs';
import { isNewsQuestion, newsReply, newsFailureMessage, NEWS_UNAVAILABLE } from './news.mjs';
import { isImageCallback, IMAGE_CHOICE_TTL, parseMediaRequest, validateMediaConfiguration, PERSONAL_MEDIA_LIMITS, nextMediaDay, generateImage, generateSpeech, uploadMedia, mediaFailureMessage } from './media.mjs';

const TTL = 30 * 60_000;
export const FOLLOWUP_NOTICE = OUTREACH_NOTICE;
export const FOLLOWUP_DELAY = 24 * 60 * 60_000;
export const FOLLOWUP_TEXT = 'سلام رفیق، امروز چطوری؟ 🙂🌱\n\nلغو احوال‌پرسی: /stop';
export const CLOUD_PRIVACY = 'پیام‌ها برای پاسخ به OpenRouter و ارائه‌دهندهٔ مدل ارسال می‌شن. درخواست‌های منتظر با اعتبار حداکثر ۱۰ دقیقه در صف کلودفلر ذخیره و در پردازش یا پاک‌سازی بعدی حذف می‌شن؛ شناسهٔ دریافت برای جلوگیری از تکرار تا ۳۰ دقیقه می‌مونه. /reset متن‌های منتظر قبلی رو هم پاک می‌کنه؛ کاری که شروع شده ممکنه قبلاً به سرویس مقصد فرستاده شده باشه. حداکثر ۳۰ پیام اخیر در کلودفلر نگه داشته و بعد از ۳۰ دقیقه بی‌فعالیتی یا /reset از حافظهٔ فعال حذف می‌شن. احوال‌پرسی پس از اطلاع کوتاه در گفتگو خودکار فعاله؛ حدود ۲۴ ساعت بعد از آخرین پیام، یک پیام عمومی می‌فرستیم، نه پیام تکراری روزانه. لغو: /stop — فعال‌سازی دوباره: /followup. شناسهٔ چت و زمان ارسال جدا از متن گفتگو ذخیره می‌شن؛ با لغو، این دو حذف و فقط ترجیح خاموشی نگه داشته می‌شه تا با پیام جدید یا /start دوباره فعال نشه. /reset هم پیگیری رو خاموش می‌کنه. پیام‌های تلگرام، داده‌های سرویس مدل و نسخه‌های پشتیبان تابع سیاست همون سرویس‌ها هستن. شهر پیش‌فرض آباده، فارس است، نه لزوماً محل زندگی تو. پیام‌های خودکار بعد از اطلاع کلیِ پیام‌دادن فعال می‌شن. جملهٔ همراه خبر هوا با OpenRouter تولید می‌شه؛ اگر گفتگوی تازه‌ای باشه، فقط یک نشانهٔ کلی برای ملایم‌ترشدن لحن به‌صورت محلی گرفته می‌شه؛ متن خصوصی گفتگو در درخواست نوشتن جمله فرستاده نمی‌شه. شهر دلخواه و مختصات تقریبی آن جداگانه برای هوا نگه داشته و به Open-Meteo ارسال می‌شه؛ حذف شهر و هشدارها: /forgetcity یا /reset. ترجیح خاموشی هوا هم جدا نگه داشته می‌شه تا با پیام جدید دوباره فعال نشه. /stop همهٔ پیام‌های خودکار رو خاموش می‌کنه. زمان درخواست تست هوا فقط برای محدودکردن مصرف تا یک ساعت نگه داشته می‌شه. چت و نوشتن پاسخ روی OpenRouter می‌مونه. برای عکس، توضیح درخواستی فقط به سرویس انتخابی تو، Free.ai یا LaoZhang و مدل تصویرش فرستاده می‌شه؛ انتخاب معلق ۱۰ دقیقه اعتبار داره و با انتخاب، /reset یا پاک‌سازی بعد از انقضا حذف می‌شه. LaoZhang مصرف اعتبار داره؛ برای ویس، فقط متن پاسخ به سرویس صدای OpenRouter و ارائه‌دهندهٔ مدل گفتار فرستاده می‌شه؛ اگر مدیر آگاهانه سرویس رسانه رو عوض کنه، مقصد همان سرویس انتخابی می‌شه. فایل خروجی Free.ai ممکنه تا مدتی روی آدرس عمومی سرویس در دسترس باشه و سیاست نگهداری خودش اعمال می‌شه؛ فایل ساخته‌شده به تلگرام ارسال می‌شه ولی این برنامه فایل رو ذخیره یا لاگ نمی‌کنه. ویس صدای مصنوعیه، نه صدای واقعی امیر. بودجهٔ مصرف عکس و ویس بدون متن یا فایل تا پایان روز UTC نگه داشته می‌شه؛ /reset این محدودیت مصرف رو پاک نمی‌کنه. اخبار ایران فقط با سؤال تو از خوراک عمومی ایسنا، بی‌بی‌سی فارسی، صداوسیما و فاکس‌نیوز و صفحهٔ عمومی کانال فارس دریافت می‌شه؛ متن خصوصی یا کلیدت به رسانه‌ها نمی‌ره. فقط تیتر و خلاصهٔ خبرها برای بازنویسی به OpenRouter می‌ره و از اعتبار مدیر استفاده می‌کنه؛ این خلاصه، تأیید مستقل گزارش رسانه نیست. دریافت خبرها تا یک دقیقه مشترک cache می‌شه؛ در قطع منبع، آخرین داده با برچسب ذخیره‌شده و فقط تا ۲۴ ساعت از انتشار قابل نمایشه. پیام خبری خودکار نداریم. تاریخ و روز هفته به وقت ایران از ساعت برنامه محاسبه می‌شه؛ مناسبت‌های ثابت محلی‌اند و تعطیلات از تقویم عمومی ایران گوگل، بدون شناسه یا پیام خصوصی، دریافت و مشترک ذخیره می‌شن. پاسخ تقویم از OpenRouter اعتبار مصرف نمی‌کنه و اعلان روزانهٔ تازه‌ای فعال نمی‌کنه. برای چت، عضویت در کانال @qhatel_roya با شناسهٔ تلگرام و از طریق خود تلگرام بررسی می‌شه؛ متن پیام برای کانال فرستاده نمی‌شه و نتیجهٔ عضویت دائماً ذخیره نمی‌شه. خروج از کانال، دسترسی چت و پیام‌های خودکار رو تا عضویت مجدد محدود می‌کنه. /stop و /reset و فرمان‌های حریم خصوصی بدون عضویت هم در دسترس‌اند. لینک پست یا ریلز عمومی برای دریافت به vxInstagram و فقط با زدن دکمهٔ موسیقی به SongFinder فرستاده می‌شه؛ نه متن گفتگو یا کلیدها. فایل ویدئو موقتاً برای ارسال دریافت می‌شه و این برنامه آن را ذخیره نمی‌کنه. شناسهٔ فایل عمومیِ آپلودشده در تلگرام تا ۵ دقیقه برای ارسال دوباره قابل استفاده است؛ نگهداری فایل در تلگرام تابع سیاست آن سرویس است. لینک عمومی و شناسهٔ پیامِ حداکثر سه دکمه تا ۳۰ دقیقه در حافظهٔ گفتگو و شمارندهٔ تلاش‌ها جدا تا پایان روز UTC می‌مونه؛ /reset لینک‌ها رو پاک می‌کنه نه سهمیه‌ها. منابع رایگان ممکنه محدود یا قطع بشن و ارسال فایل کامل آهنگ تضمین نیست. پست‌های عمومی جدید کانال با توضیح کوتاه تا ۳۰ روز ثبت می‌شن؛ نه فایل یا متن خصوصی. انتخاب از کپشنه، نه شنیدن یا دیدن فایل؛ پیشنهادهای شخصی تا پایان جلسه یا /reset می‌مونن. پستِ مرتبط می‌تونه بدون دکمه با نام کانال فرستاده بشه؛ ارسال زمینه‌ای خودکار حداکثر روزی یک پسته و لغوش /channelstop یا /stop است. فقط زمان و شناسهٔ پستِ این ارسال تا ۲۴ ساعت برای جلوگیری از تکرار نگه داشته می‌شه. لطفاً اطلاعات حساس نفرست.';
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
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return new Response('Invalid update', { status: 400 });
      if (update.channel_post || update.edited_channel_post) {
        const post = compactChannelPost(update);
        if (!post) return ok();
        try {
          const id = env.MARKETS.idFromName('channel-library');
          const response = await env.MARKETS.get(id).fetch('https://market.internal/channel-update', { method: 'POST', body: JSON.stringify(post) });
          return response.ok ? ok() : new Response('Temporarily unavailable', { status: 503 });
        } catch { return new Response('Temporarily unavailable', { status: 503 }); }
      }
      const callback = update.callback_query;
      if (callback && (update.message || (callback.data !== JOIN_CALLBACK && !isMusicCallback(callback.data) && !isChannelCallback(callback.data) && !isImageCallback(callback.data)) || typeof callback.id !== 'string' || !callback.id.length || callback.id.length > 256 || (!Number.isSafeInteger(callback.message?.message_id) || callback.message.message_id <= 0))) return ok();
      const message = callback ? { ...callback.message, from: callback.from } : update.message;
      if (!message?.from || message.from.is_bot || message.chat?.type !== 'private') return ok();
      if (!Number.isSafeInteger(message.from.id) || !Number.isSafeInteger(message.chat.id) || message.from.id <= 0 || message.from.id !== message.chat.id) return ok();
      const allowed = env.TELEGRAM_ALLOWED_USER_IDS.trim();
      if (allowed !== '*' && !allowed.split(',').map(s => s.trim()).includes(String(message.from.id))) return ok();
      const objectId = env.CHATS.idFromName(String(message.from.id));
      try {
        return await env.CHATS.get(objectId).fetch('https://chat.internal/' + (asyncUpdates(env) ? 'enqueue' : 'update'), {
          method: 'POST', body: JSON.stringify(asyncUpdates(env) ? compactUpdate(update, url.origin + '/webhook') : { ...update, webhookURL: url.origin + '/webhook' }),
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
// Webhooks acknowledge after durable admission; alarms own the bounded work.
// No waitUntil lifetime assumptions and no paid-generation retry after reservation.
export class ChatSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.alarmQueue = Promise.resolve();
    this.inbox = new DurableInbox(ctx.storage);
    this.membership = new MembershipGate((method, body) => this.telegram(method, body));
    this.callbackSetupAt = 0;
    this.weather = new WeatherAssistant(ctx.storage, env, (chat, text) => this.send(chat, text), () => this.scheduleAlarm(), (chat, event) => this.maybeSendChannelMoment(chat, event), chat => this.canReceiveChannelPost(chat));
  }
  fetch(request) {
    if (new URL(request.url).pathname === '/enqueue') return request.json().then(update => this.enqueue(update));
    const task = this.queue.then(async () => this.process(await request.json()));
    this.queue = task.catch(() => {});
    return task;
  }
  alarm() {
    const task = this.queue.then(async () => {
      if (asyncUpdates(this.env) || await this.ctx.storage.get('inbox')) await this.drainInbox();
      await this.inbox.cleanup();
      const record = await this.ctx.storage.get('session');
      if (record && record.expiresAt <= Date.now()) await this.ctx.storage.delete('session');
      else if (record && (record.instagramJobs?.some(job => job.expiresAt <= Date.now()) || record.channelOffers?.some(job => job.expiresAt <= Date.now()))) {
        if (record.instagramJobs) record.instagramJobs = record.instagramJobs.filter(job => job.expiresAt > Date.now());
        if (record.channelOffers) record.channelOffers = record.channelOffers.filter(job => job.expiresAt > Date.now());
        await this.ctx.storage.put('session', record);
      }
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
      const choiceSession = await this.ctx.storage.get('session');
      if (choiceSession?.imageChoice?.expiresAt <= Date.now()) { delete choiceSession.imageChoice; await this.ctx.storage.put('session', choiceSession); }
      const channelAuto = await this.ctx.storage.get('channelAuto');
      if (channelAuto?.expiresAt <= Date.now()) await this.ctx.storage.delete('channelAuto');
      const mediaUsage = await this.ctx.storage.get('mediaUsage');
      if (mediaUsage?.expiresAt <= Date.now()) await this.ctx.storage.delete('mediaUsage');
      const instagramUsage = await this.ctx.storage.get('instagramUsage');
      if (instagramUsage?.expiresAt <= Date.now()) await this.ctx.storage.delete('instagramUsage');
      let weather = await this.ctx.storage.get('weather');
      const knownChat = weather?.chatId || followup?.chatId;
      if (Number.isSafeInteger(knownChat) && knownChat > 0 && (!weather?.alertsEnabled || !Number.isFinite(weather?.nextCheckAt) || weather.nextCheckAt <= 0) &&
          followup?.noticeShown && !followup.disabled && !await this.ctx.storage.get('weatherOptOut') && await this.canReceiveChannelPost(knownChat)) {
        await this.ensureDefaultWeather(knownChat);
        weather = await this.ctx.storage.get('weather');
      }
      if (weather?.alertsEnabled && weather.nextCheckAt <= Date.now() && membershipRequired(this.env) && await this.membership.check(weather.chatId) !== 'member') {
        // Pause paid weather prose while outside the channel or Telegram is down;
        // preserve the user's existing subscription and explicit opt-out choices.
        await this.ctx.storage.put('weather', { ...weather, nextCheckAt: Date.now() + 60 * 60_000 });
      } else await this.runWeatherAlarm(weather);
      await this.scheduleAlarm();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  scheduleAlarm(candidate = Infinity) {
    const task = this.alarmQueue.then(async () => {
      const record = await this.ctx.storage.get('session');
      const followup = await this.ctx.storage.get('followup');
      const weather = await this.ctx.storage.get('weather');
      const preview = await this.ctx.storage.get('snowPreview');
      const mediaUsage = await this.ctx.storage.get('mediaUsage');
      const instagramUsage = await this.ctx.storage.get('instagramUsage');
      const inbox = await this.ctx.storage.get('inbox');
      const channelAuto = await this.ctx.storage.get('channelAuto');
      const times = [candidate, record?.expiresAt, (followup?.disabled ? null : followup?.dueAt), nextWeatherWake(weather), preview?.expiresAt, mediaUsage?.expiresAt, instagramUsage?.expiresAt, nextInstagramJob(record), record?.imageChoice?.expiresAt, nextChannelOffer(record), nextInboxWake(inbox), channelAuto?.expiresAt].filter(time => Number.isFinite(time) && time > 0);
      if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, Math.min(...times)));
      else await this.ctx.storage.deleteAlarm();
    });
    this.alarmQueue = task.catch(() => {}); return task;
  }
  async armFollowup(chatId, record) {
    const followup = { chatId, dueAt: Date.now() + FOLLOWUP_DELAY, noticeShown: true, disabled: false };
    await this.scheduleAlarm(Math.min(record.expiresAt, followup.dueAt));
    await this.ctx.storage.put('followup', followup);
    await this.scheduleAlarm();
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
      await this.weather.ensureAutomatic(chat, needsNotice || !!preference?.noticeShown);
    }
  }
  async ensureAutomaticFollowup(chat, record) {
    const preference = await this.ctx.storage.get('followup');
    if (preference?.disabled) return;
    // Deliver the disclosure before enabling automatic outreach. Existing
    // opt-in subscriptions remain valid, but are informed on their next chat.
    if (!preference?.noticeShown) await this.send(chat, FOLLOWUP_NOTICE);
    await this.armFollowup(chat, record);
    await this.weather.ensureAutomatic(chat, true);
  }
  async ensureDefaultWeather(chat) {
    const preference = await this.ctx.storage.get('followup');
    if (preference?.disabled) return; // Preserve legacy global /stop and /reset.
    const changed = await this.weather.ensureAutomatic(chat, !!preference?.noticeShown);
    if (changed && !preference?.noticeShown) {
      // The generic notice was delivered by ensureAutomatic. Do not enroll a
      // check-in or ask a city question just because a feature command was used.
      await this.ctx.storage.put('followup', { ...preference, noticeShown: true });
    }
  }
  async telegram(method, body, timeoutMs = 8000) {
    const fetchImpl = this.env.fetchImpl || fetch;
    const response = await fetchImpl(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
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
    if (record.channelOffers) record.channelOffers = record.channelOffers.filter(job => job.expiresAt > Date.now());
    if (record.instagramJobs) record.instagramJobs = record.instagramJobs.filter(job => job.expiresAt > Date.now());
    // Set the cleanup alarm before writing sensitive data; a failed write leaves
    // only a harmless alarm, not stored data with no scheduled cleanup.
    await this.scheduleAlarm(record.expiresAt);
    await this.ctx.storage.put('session', record);
    await this.scheduleAlarm();
  }
  async capacity(body) {
    const id = this.env.MARKETS.idFromName('bot-capacity');
    const response = await this.env.MARKETS.get(id).fetch('https://market.internal/capacity', { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Capacity unavailable');
    return response.json();
  }
  async enqueue(update) {
    const callback = update.callback_query;
    if (callback) {
      await this.telegram('answerCallbackQuery', { callback_query_id: callback.id }, 2000).catch(() => {});
      update.callbackAcknowledged = true;
    }
    await this.scheduleAlarm(Date.now() + 100);
    const result = await this.inbox.admit(update, async (id, priority) => (await this.capacity({ op: 'admit', id, priority })).granted);
    if (result.removed?.length) await this.capacity({ op: 'release', ids: result.removed }).catch(() => {});
    await this.scheduleAlarm();
    if (result.notice) {
      const chat = callback?.from.id || update.message.chat.id;
      await this.telegram('sendMessage', { chat_id: chat, text: BUSY_TEXT }, 2000).catch(() => {});
    }
    return ok();
  }
  async drainInbox() {
    const job = await this.inbox.peek();
    if (!job) return;
    const chat = job.update.callback_query?.from.id || job.update.message.chat.id;
    const allowed = this.env.TELEGRAM_ALLOWED_USER_IDS?.trim() || '';
    const authorized = allowed === '*' || allowed.split(',').map(s => s.trim()).includes(String(chat));
    if (job.expiresAt <= Date.now() || !authorized) {
      await this.inbox.finish(job.id);
      await this.capacity({ op: 'finish', id: job.id }).catch(() => {});
      if (authorized && job.expiresAt <= Date.now()) await this.send(chat, EXPIRED_TEXT).catch(() => {});
      return;
    }
    const text = job.update.message?.text || '';
    const media = parseMediaRequest(text);
    const record = await this.ctx.storage.get('session');
    let waitUntil = 0;
    if (!priorityUpdate(job.update) && !job.update.callback_query && !text.startsWith('/')) waitUntil = Math.max(record?.lastAt || 0, record?.lastLiveAt || 0) + 4000;
    if (media) waitUntil = Math.max(waitUntil, (await this.ctx.storage.get('mediaUsage'))?.lastAt + 60000 || 0);
    if (waitUntil > Date.now()) { await this.inbox.defer(waitUntil - Date.now(), job.id); return; }
    let granted = false;
    try { granted = (await this.capacity({ op: 'start', id: job.id, kind: media || instagramRequest(text) || isMusicCallback(job.update.callback_query?.data) || isImageCallback(job.update.callback_query?.data) || isChannelCallback(job.update.callback_query?.data) || (automaticChannelPosts(this.env) && (channelRequest(text)?.kind || positiveWeatherContext(text))) ? 'media' : 'text' })).granted; }
    catch { /* Retry admission later, never run without a capacity lease. */ }
    if (!granted) { await this.inbox.defer(undefined, job.id); return; }
    const claimed = await this.inbox.claim(job.id);
    if (!claimed) { await this.capacity({ op: 'finish', id: job.id }).catch(() => {}); return; }
    await this.scheduleAlarm(); // Recovery wake survives worker eviction/crash.
    let finished = false;
    try { await this.process(claimed.update); finished = true; }
    catch { await this.inbox.defer(5000, job.id); } // process itself deduplicates before any provider call.
    finally {
      if (finished) await this.inbox.finish(job.id);
      await this.capacity({ op: finished ? 'finish' : 'pause', id: job.id }).catch(() => {});
    }
  }
  async runWeatherAlarm(weather) {
    if (!asyncUpdates(this.env) || !weather?.alertsEnabled || weather.nextCheckAt > Date.now()) return this.weather.alarm();
    const id = 'weather-' + crypto.randomUUID(); let granted = false;
    try {
      if ((await this.capacity({ op: 'admit', id })).granted) granted = (await this.capacity({ op: 'start', id, kind: 'text' })).granted;
      if (granted) await this.weather.alarm();
      else await this.ctx.storage.put('weather', { ...weather, nextCheckAt: Date.now() + 60000 + Math.floor(Math.random() * 60000) });
    } catch {
      // Preserve any event claim/opt-out written before a late error: restoring
      // the old snapshot could repeat an already billed generation.
      const current = await this.ctx.storage.get('weather');
      if (current?.alertsEnabled) await this.ctx.storage.put('weather', { ...current, nextCheckAt: Date.now() + 60000 });
    } finally { await this.capacity({ op: 'finish', id }).catch(() => {}); }
  }
  async reserveInstagram(kind) {
    const now = Date.now(), expiresAt = igDayEnd(now);
    let usage = await this.ctx.storage.get('instagramUsage');
    if (usage?.expiresAt !== expiresAt) usage = { expiresAt, video: 0, music: 0 };
    if (usage[kind] >= IG_PERSONAL_LIMIT) throw new InstagramError('LIMIT');
    if (usage[kind + 'At'] && now - usage[kind + 'At'] < 10000) throw new InstagramError('RATE');
    usage[kind]++; usage[kind + 'At'] = now;
    await this.scheduleAlarm(Math.min(now + TTL, expiresAt));
    await this.ctx.storage.put('instagramUsage', usage);
    await this.scheduleAlarm();
  }
  async channelCall(path, body) {
    const id = this.env.MARKETS.idFromName('channel-library');
    const response = await this.env.MARKETS.get(id).fetch('https://market.internal/channel-' + path, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Channel unavailable');
    return (await response.json()).value;
  }
  async readableChannel() {
    const channel = await this.telegram('getChat', { chat_id: LIBRARY_CHANNEL });
    if (channel?.type !== 'channel' || !Number.isSafeInteger(channel.id) || channel.id >= 0 ||
        String(channel.username || '').toLowerCase() !== LIBRARY_CHANNEL.slice(1) || channel.has_protected_content) throw new Error('Channel unavailable');
    return channel.id;
  }
  async canReceiveChannelPost(chat) {
    const allowed = this.env.TELEGRAM_ALLOWED_USER_IDS?.trim() || '';
    if (allowed !== '*' && !allowed.split(',').map(v => v.trim()).includes(String(chat))) return false;
    return !membershipRequired(this.env) || await this.membership.check(chat) === 'member';
  }
  async forwardLibraryRow(chat, row) {
    if (!await this.canReceiveChannelPost(chat) || await this.readableChannel() !== row.channelId) throw new Error('Channel unavailable');
    const current = await this.channelCall('get', { channelId: row.channelId, id: row.id });
    if (!current || current.version !== row.version || current.revisionAt !== row.revisionAt) throw new Error('Post changed');
    try { await this.telegram('forwardMessage', { chat_id: chat, from_chat_id: row.channelId, message_id: row.id }); }
    catch {
      await this.channelCall('invalidate', { channelId: row.channelId, id: row.id, version: row.version, revisionAt: row.revisionAt }).catch(() => {});
      throw new Error('Forward unavailable');
    }
  }
  async disableChannelAutomatic() {
    await this.ctx.storage.put('channelOptOut', true);
    const usage = await this.ctx.storage.get('channelAuto');
    if (usage) await this.ctx.storage.put('channelAuto', { lastAt: usage.lastAt, expiresAt: usage.expiresAt });
  }
  async maybeSendChannelMoment(chat, event, record = null, inMediaLease = false) {
    if (!automaticChannelPosts(this.env) || !event || event.severe || event.unsafe) return;
    let ticket = null;
    try {
      const preference = await this.ctx.storage.get('channelOptOut');
      if (preference === true || (preference !== false && ((await this.ctx.storage.get('followup'))?.disabled || await this.ctx.storage.get('weatherOptOut')))) return;
      const usage = await this.ctx.storage.get('channelAuto');
      if (usage?.lastAt && Date.now() - usage.lastAt < AUTO_POST_INTERVAL) return;
      record ||= await this.ctx.storage.get('session');
      if (record?.expiresAt <= Date.now()) record = null;
      if (Date.now() - (record?.channelDeliveryAt || 0) < 10000) return;
      // Optional weather attachments take their own bounded media lease; never
      // wait for a slot or delay the factual notification on a busy source.
      if (!inMediaLease) {
        ticket = 'weather-' + crypto.randomUUID();
        if (!(await this.capacity({ op: 'admit', id: ticket })).granted || !(await this.capacity({ op: 'start', id: ticket, kind: 'media' })).granted) return;
      }
      if (!await this.canReceiveChannelPost(chat)) return;
      const channelId = await this.readableChannel();
      const exclude = [...(record?.channelRecent || []).filter(r => r.channelId === channelId).map(r => r.id), ...(usage?.channelId === channelId ? [usage.postId] : [])].slice(-10);
      const row = await this.channelCall('find', { channelId, kind: 'moment', weather: event.kind, exclude });
      if (!row) return; // No unrelated or fabricated fallback post.
      const marker = { lastAt: Date.now(), expiresAt: Date.now() + AUTO_POST_INTERVAL, channelId, postId: row.id };
      await this.scheduleAlarm(marker.expiresAt);
      await this.ctx.storage.put('channelAuto', marker); // Claim before send, including ambiguous timeouts.
      await this.scheduleAlarm();
      await this.forwardLibraryRow(chat, row);
      if (record) { record.channelRecent = [...(record.channelRecent || []), { channelId, id: row.id }].slice(-10); await this.persist(record); }
    } catch { /* Optional extra: no blind retry, provider fallback or raw logs. */ }
    finally { if (ticket) await this.capacity({ op: 'finish', id: ticket }).catch(() => {}); }
  }
  async offerChannelPost(chat, request, record) {
    if (!request.kind) { await this.send(chat, 'از پست‌های جدید کانال چی می‌خوای؟ 🌱\n/song آهنگ — /clip کلیپ — /quote جمله\nمثلاً: /song شاد\nانتخاب از توضیح و کپشنه، نه شنیدن یا دیدن فایل.'); return; }
    if (Date.now() - (record.channelOfferAt || 0) < 4000) { await this.send(chat, 'چند ثانیه صبر کن، بعد از کانال انتخاب می‌کنیم 🌱'); return; }
    record.channelOfferAt = Date.now(); await this.persist(record);
    try {
      const channelId = await this.readableChannel();
      const row = await this.channelCall('find', { channelId, kind: request.kind, query: request.query, exclude: (record.channelRecent || []).filter(r => r.channelId === channelId).map(r => r.id) });
      if (!row) { await this.send(chat, 'بین پست‌های ثبت‌شدهٔ کانال، گزینهٔ متناسب پیدا نکردم 🌱 فقط پست‌های جدیدِ بعد از فعال‌شدن این قابلیت رو می‌شناسم؛ می‌تونی درخواستت رو ساده‌تر بگی یا خود کانال رو ببینی: ' + LIBRARY_CHANNEL); return; }
      if (automaticChannelPosts(this.env)) {
        if (Date.now() - Math.max(record.channelDeliveryAt || 0, (await this.ctx.storage.get('channelAuto'))?.lastAt || 0) < 10000) { await this.send(chat, 'بین ارسال پست‌های کانال ده ثانیه فاصله بذار 🌱'); return; }
        record.channelDeliveryAt = Date.now(); await this.persist(record);
        await this.forwardLibraryRow(chat, row);
        record.channelRecent = [...(record.channelRecent || []), { channelId, id: row.id }].slice(-10); await this.persist(record);
        return;
      }
      const token = crypto.randomUUID().replaceAll('-', '');
      const offer = { token, channelId, id: row.id, version: row.version, revisionAt: row.revisionAt, expiresAt: Date.now() + OFFER_TTL, messageId: null, used: false };
      record.channelOffers = [...(record.channelOffers || []).filter(o => o.expiresAt > Date.now()).slice(-2), offer];
      await this.persist(record);
      const excerpt = [row.title, row.performer, row.text].filter(Boolean).join(' — ').slice(0, 240);
      const result = await this.telegram('sendMessage', { chat_id: chat,
        text: `از توضیح پست‌های ثبت‌شدهٔ کانال، این ${channelKindLabel(row.kind)} رو پیدا کردم 🌱${excerpt ? '\n\n' + excerpt : ''}\n\nبفرستم؟`,
        link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [
          [{ text: '✅ بفرست', callback_data: 'chpick:' + token }],
          [{ text: '📢 دیدن پست در کانال', url: 'https://t.me/' + LIBRARY_CHANNEL.slice(1) + '/' + row.id }],
        ] } });
      if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) throw new Error('Delivery unavailable');
      offer.messageId = result.message_id; await this.persist(record);
    } catch { await this.send(chat, 'الان نتونستم انتخاب یا ارسال پست رو تأیید کنم؛ برای جلوگیری از ارسال تکراری، خودکار دوباره تلاش نمی‌کنم 🌱'); }
  }
  async deliverChannelPost(chat, callback, record) {
    const offer = record.channelOffers?.find(o => o.token === callback.data.slice(7) && o.messageId === callback.message.message_id && o.expiresAt > Date.now());
    if (!offer) { await this.send(chat, 'این انتخاب دیگه معتبر نیست؛ با /channel دوباره انتخاب کن 🌱'); return; }
    if (offer.used) { await this.send(chat, 'این انتخاب قبلاً مصرف شده؛ برای انتخاب تازه /channel رو بزن 🌱'); return; }
    if (Date.now() - Math.max(record.channelDeliveryAt || 0, (await this.ctx.storage.get('channelAuto'))?.lastAt || 0) < 10000) { await this.send(chat, 'بین ارسال پست‌های کانال ده ثانیه فاصله بذار 🌱'); return; }
    // Claim before any Telegram send. A timeout can hide successful delivery;
    // never retry it blindly or fall back to a cached file_id/copyMessage.
    offer.used = true; record.channelDeliveryAt = Date.now(); await this.persist(record);
    try {
      const channelId = await this.readableChannel();
      if (channelId !== offer.channelId) throw new Error('Channel changed');
      const row = await this.channelCall('get', { channelId, id: offer.id });
      if (!row || row.version !== offer.version || row.revisionAt !== offer.revisionAt) { await this.send(chat, 'پست حذف، ویرایش یا غیرقابل‌ارسال شده؛ با /channel دوباره انتخاب کن 🌱'); return; }
      await this.forwardLibraryRow(chat, row);
      record.channelRecent = [...(record.channelRecent || []), { channelId, id: row.id }].slice(-10); await this.persist(record);
      await this.telegram('editMessageReplyMarkup', { chat_id: chat, message_id: offer.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    } catch { await this.send(chat, 'نتونستم ارسال این پست رو تأیید کنم؛ ممکنه حذف یا محدود شده باشه. ارسال خودکار دوباره انجام نمی‌دم؛ از /channel انتخاب تازه بگیر 🌱'); }
  }
  async instagramCall(path, url, extra = {}) {
    const id = this.env.MARKETS.idFromName('instagram-free');
    const response = await this.env.MARKETS.get(id).fetch('https://market.internal/' + path, { method: 'POST', body: JSON.stringify({ url, ...extra }) });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new InstagramError(['RATE', 'LIMIT', 'SIZE', 'NO_MATCH'].includes(data.code) ? data.code : 'SOURCE');
    return data.value;
  }
  async handleInstagramVideo(chat, request, record, webhookURL) {
    if (!request.url) { await this.send(chat, 'یک لینک کاملِ پست ویدئویی یا ریلز عمومی بفرست 🌱 لینک خصوصی، استوری و چند لینک هم‌زمان پشتیبانی نمی‌شن.'); return; }
    try {
      await this.prepareMembershipButtons(webhookURL);
      await this.reserveInstagram('video');
      const cachedFile = await this.instagramCall('ig-file-get', request.url).catch(() => null);
      const bytes = cachedFile || await downloadInstagramVideo(this.env.fetchImpl || fetch, await this.instagramCall('ig-resolve', request.url));
      const token = crypto.randomUUID().replaceAll('-', '');
      record.instagramJobs = (record.instagramJobs || []).filter(job => job.expiresAt > Date.now()).slice(-2);
      const job = { token, url: request.url, expiresAt: Date.now() + IG_JOB_TTL, messageId: null, used: false };
      record.instagramJobs.push(job);
      await this.persist(record);
      let uploaded;
      try { uploaded = await uploadInstagramVideo(this.env, chat, bytes, token, request.url, true); }
      catch (error) {
        if (cachedFile) await this.instagramCall('ig-file-put', request.url, { fileId: null }).catch(() => {});
        throw error; // Never blindly repeat a possibly successful Telegram send.
      }
      job.messageId = uploaded.messageId;
      if (uploaded.fileId) await this.instagramCall('ig-file-put', request.url, { fileId: uploaded.fileId }).catch(() => {});
      await this.persist(record);
    } catch (error) { await this.send(chat, instagramFailure(error)); }
  }
  async handleInstagramMusic(chat, callback, record) {
    const token = callback.data.slice('igmusic:'.length);
    const job = record.instagramJobs?.find(job => job.token === token && job.expiresAt > Date.now() && job.messageId === callback.message.message_id);
    if (!job) { await this.send(chat, 'این دکمه منقضی یا نامعتبره؛ لینک ریلز رو دوباره بفرست 🌱'); return; }
    if (job.used) { await this.send(chat, job.reply ? 'نتیجهٔ تلاش قبلی:\n' + job.reply : 'این درخواست قبلاً ثبت شده؛ برای تلاش تازه، لینک رو دوباره بفرست 🌱'); return; }
    try {
      await this.reserveInstagram('music');
      job.used = true; await this.persist(record); // Claim before upstream: no duplicate quota spending.
      await this.send(chat, 'دارم موسیقیش رو بررسی می‌کنم 🎵 ممکنه چند ثانیه طول بکشه.');
      job.reply = musicReply(await this.instagramCall('ig-recognize', job.url));
    } catch (error) { job.reply = instagramFailure(error) + '\nبرای تلاش تازه، لینک ریلز رو دوباره بفرست.'; }
    await this.persist(record);
    await this.send(chat, job.reply);
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
    await this.scheduleAlarm(Math.min(now + TTL, usage.expiresAt));
    await this.ctx.storage.put('mediaUsage', usage);
    await this.scheduleAlarm();
    return null;
  }
  async offerImageChoice(chat, prompt, record) {
    const token = crypto.randomUUID().replaceAll('-', '');
    // Only one pending prompt per chat, never included in model history.
    record.imageChoice = { token, prompt, chatId: chat, expiresAt: Date.now() + IMAGE_CHOICE_TTL };
    await this.persist(record);
    const message = await this.telegram('sendMessage', { chat_id: chat,
      text: 'عکس رو با کدوم سرویس بسازم؟ 🎨\nLaoZhang از اعتبار همون حساب مصرف می‌کنه؛ اگر اعتبار نداشته باشه انجام نمی‌شه. سقف مصرف هر دو مشترکه.',
      reply_markup: { inline_keyboard: [[
        { text: 'Free.ai', callback_data: `imgpick:${token}:freeai` },
        { text: 'LaoZhang · اعتباری', callback_data: `imgpick:${token}:laozhang` },
      ]] } });
    if (!Number.isSafeInteger(message?.message_id)) { delete record.imageChoice; await this.persist(record); return; }
    record.imageChoice.messageId = message.message_id;
    await this.persist(record);
  }
  async chooseImageProvider(chat, callback, record) {
    const [, token, provider] = callback.data.split(':');
    const choice = record.imageChoice;
    if (!choice || choice.chatId !== chat || choice.token !== token || choice.expiresAt <= Date.now() || choice.messageId !== callback.message.message_id) {
      await this.send(chat, 'این انتخاب منقضی یا قبلاً استفاده شده؛ دوباره درخواست عکس رو بفرست 🌱'); return;
    }
    // Consume both buttons before any quota reservation, generation or upload.
    delete record.imageChoice; await this.persist(record);
    await this.telegram('editMessageReplyMarkup', { chat_id: chat, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await this.handleMedia(chat, { kind: 'image', prompt: choice.prompt, provider }, record);
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
    if (kind === 'image' && !request.provider) { await this.offerImageChoice(chat, prompt, record); return; }
    if (kind === 'image' && !['freeai', 'laozhang'].includes(request.provider)) { await this.send(chat, 'سرویس تصویر نامعتبره 🌱'); return; }
    if (kind === 'image' && record.imageChoice) { delete record.imageChoice; await this.persist(record); }
    const mediaEnv = kind === 'image' ? { ...this.env, MEDIA_IMAGE_PROVIDER: request.provider } : this.env;
    try {
      validateMediaConfiguration(mediaEnv, kind);
      const denied = await this.reserveMedia(kind);
      if (denied) { await this.send(chat, denied); return; }
      if (kind === 'image') {
        await this.send(chat, 'دارم عکست رو می‌سازم 🎨✨ ممکنه کمی طول بکشه.');
        await uploadMedia(this.env, chat, kind, await generateImage(mediaEnv, prompt));
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
    if (record.imageChoice?.expiresAt <= Date.now()) delete record.imageChoice;
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
        if (!update.callbackAcknowledged) await this.telegram('answerCallbackQuery', { callback_query_id: callback.id }, 2000).catch(() => {});
        const status = membershipRequired(this.env) ? await this.membership.check(chat) : 'member';
        if (status === 'member') await this.ensureDefaultWeather(chat);
        if (status === 'member' && isImageCallback(callback.data)) {
          await this.chooseImageProvider(chat, callback, record);
        } else if (status === 'member' && isChannelCallback(callback.data)) {
          await this.deliverChannelPost(chat, callback, record);
        } else if (status === 'member' && isMusicCallback(callback.data)) {
          await this.handleInstagramMusic(chat, callback, record);
        } else if (status === 'member') {
          await this.telegram('editMessageReplyMarkup', { chat_id: chat, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await this.send(chat, 'عضویتت تأیید شد ✅🌱 حالا پیامت رو بفرست تا گپ بزنیم.');
        } else await this.showMembershipGate(chat, status);
        return ok();
      }
      // Privacy, cancellation and public contact remain available without joining.
      const gateExempt = ['/stop', '/reset', '/privacy', '/about', '/help', '/weatherstop', '/forgetcity', '/channelstop'].includes(command) || isCreatorQuestion(text);
      if (membershipRequired(this.env) && !gateExempt) {
        await this.prepareMembershipButtons(update.webhookURL);
        const status = await this.membership.check(chat);
        if (status !== 'member') { await this.showMembershipGate(chat, status); return ok(); }
      }
      if (command === '/reset' || command === '/start') {
        if (command === '/reset') {
          await this.disableFollowup();
          await this.disableChannelAutomatic();
          await this.weather.stop(true);
        }
        record.messages = [];
        record.instagramJobs = [];
        delete record.imageChoice;
        delete record.channelOffers; delete record.channelRecent; delete record.channelOfferAt; delete record.channelDeliveryAt;
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
        await this.disableChannelAutomatic();
        await this.disableFollowup();
        await this.weather.stop();
        await this.scheduleAlarm();
        await this.send(chat, 'همهٔ پیام‌های خودکار خاموش شد ✅🌱 احوال‌پرسی: /followup — هشدار هوا: /alerts');
        return ok();
      }
      if (command === '/channelstop') { await this.disableChannelAutomatic(); await this.send(chat, 'پست خودکار کانال خاموش شد 🌱 درخواست مستقیم /song و /clip و /quote همچنان کار می‌کنه. فعال‌سازی دوباره: /channelauto'); return ok(); }
      if (command === '/channelauto') { await this.ctx.storage.put('channelOptOut', false); await this.send(chat, 'پست مرتبطِ خودکار فعال شد 🌱 حداکثر روزی یک پست کنار گفتگوی مرتبط یا خبر هوا؛ لغو: /channelstop یا /stop'); return ok(); }
      if (command === '/about') { await this.send(chat, ABOUT); return ok(); }
      if (command === '/privacy') { await this.send(chat, CLOUD_PRIVACY); return ok(); }
      if (command === '/help') {
        await this.send(chat, '/start سلام و شروع دوباره\n/about دربارهٔ امیر\n/creator ارتباط با سازنده\n/reset پاک‌کردن حافظهٔ فعال گفتگو\n/privacy حریم خصوصی\n/followup فعال‌سازی دوبارهٔ احوال‌پرسی\n/stop لغو همهٔ پیام‌های خودکار\n/image توضیح عکس دلخواه؛ سپس انتخاب Free.ai یا LaoZhang\n/voice سؤال یا خواندن پاسخ قبلی با صدای مصنوعی\n/channel انتخاب از پست‌های جدید کانال\n/song آهنگ از کانال — /clip کلیپ — /quote جمله\n/channelstop لغو پست خودکار کانال — /channelauto فعال‌سازی\nلینک ریلز یا پست ویدئویی عمومی: دریافت ویدئو و دکمهٔ شناسایی موسیقی؛ هر نفر روزی ۵ تلاش برای هر بخش، حداکثر ۲۰ مگابایت\n/date تاریخ، روز هفته و مناسبت‌های ثبت‌شده\n/prices قیمت دلار و طلا\n/news یا «چه خبر؟» اخبار ایران\n/city نام شهر\n/weather وضعیت هوا\n/test_snow یا /test_rain یا /test_cloud تست شخصی و ساختگی هوا\n/alerts برگرداندن خبرهای هوا بعد از لغو (پیش‌فرض فعاله)\n/weatherstop خاموش‌کردن هشدار هوا\n/forgetcity حذف شهر\n\nورودی فقط متن در چت خصوصی؛ عکس و ویس فقط با درخواست خودت، از اعتبار مدیر و با سقف مصرف. هر نفر روزی پنج عکس و سه ویس؛ کل ربات ده عکس و ده ویس (روز UTC). صدای ویس مصنوعیه. من هوش مصنوعی‌ام و جایگزین درمانگر یا خدمات اضطراری نیستم.');
        return ok();
      }
      if (isCreatorQuestion(text)) {
        await this.send(chat, CREATOR_REPLY);
        record.messages = [...record.messages, { role: 'user', content: text }, { role: 'assistant', content: CREATOR_REPLY }].slice(-HISTORY_LIMIT);
        record.expiresAt = Date.now() + TTL;
        await this.persist(record);
        return ok();
      }
      if (['/test_snow', '/test_rain', '/test_cloud'].includes(command)) {
        await this.weather.previewWeather(chat, command.slice(6));
        return ok();
      }
      if (command === '/weatherstop' || command === '/forgetcity') {
        await this.weather.handle(text, chat);
        return ok();
      }
      if (!text) { await this.send(chat, 'فعلاً فقط پیام متنی رو می‌تونم بخونم 🌱'); return ok(); }
      if (text.length > 6000) { await this.send(chat, 'لطفاً پیامت رو به بخش‌های کمتر از ۶۰۰۰ کاراکتر تقسیم کن.'); return ok(); }
      const instagram = instagramRequest(text);
      const earlyFeature = instagram || parseMediaRequest(text) || channelRequest(text) || isCalendarQuestion(text) || isNewsQuestion(text) || isMarketQuestion(text) || isWeatherQuestion(text) || ['/prices', '/city', '/weather'].includes(command);
      if (earlyFeature && command !== '/alerts') await this.ensureDefaultWeather(chat);
      if (instagram && !text.startsWith('/')) { await this.handleInstagramVideo(chat, instagram, record, update.webhookURL); return ok(); }
      const mediaRequest = parseMediaRequest(text);
      if (mediaRequest) {
        await this.handleMedia(chat, mediaRequest, record);
        return ok();
      }
      const requestedPost = channelRequest(text);
      if (requestedPost) { await this.offerChannelPost(chat, requestedPost, record); return ok(); }
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
      await this.maybeSendChannelMoment(chat, positiveWeatherContext(text), record, asyncUpdates(this.env)).catch(() => {});
    } catch {
      // Update is reserved even when provider/delivery fails. User can send a new
      // message; do not retry blindly and incur additional OpenRouter charges.
      try { await this.send(chat, FAILURE); } catch { /* No sensitive logs. */ }
    }
    return ok();
  }
}

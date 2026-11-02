import { complete, splitMessage, PERSONA_GREETING, HISTORY_LIMIT } from './core.mjs';
import { handleSetup } from './setup.mjs';
import { formatReply } from './format.mjs';

const TTL = 30 * 60_000;
export const FOLLOWUP_DELAY = 24 * 60 * 60_000;
export const FOLLOWUP_TEXT = 'سلام رفیق 🌱🙂 گفتم یه احوالی بپرسم؛ امروز چطوری؟ اگه دوست داشتی از حال و کارت بگو 💬✨\n\nلغو احوال‌پرسی: /stop';
export const CLOUD_PRIVACY = 'پیام‌ها برای پاسخ به OpenRouter و ارائه‌دهندهٔ مدل ارسال می‌شن. حداکثر ۳۰ پیام اخیر در فضای خصوصی Durable Objects کلودفلر ذخیره می‌شه و پس از ۳۰ دقیقه بی‌فعالیتی یا /reset از حافظهٔ فعال برنامه حذف می‌شه. سیاست نگهداری و نسخه‌های پشتیبان سرویس‌ها جداست. این فرمان پیام‌های تلگرام یا داده‌های ارائه‌دهندهٔ مدل رو حذف نمی‌کنه. متن گفتگو در لاگ برنامه ثبت نمی‌شه. اگر /followup را فعال کنی، شناسهٔ چت و زمان احوال‌پرسی جدا از متن گفتگو تا /stop یا /reset نگه داشته می‌شه؛ یک احوال‌پرسی عمومی حدود ۲۴ ساعت بعد از آخرین پیام متنی می‌فرستیم. لطفاً اطلاعات حساس نفرست.';
const INTRO = `${PERSONA_GREETING}\n\n${CLOUD_PRIVACY}\n\nاحوال‌پرسی فردا اختیاریه: /followup — لغو: /stop\n\nاین روزها مشغول چه کاری هستی و کجاش گیر کردی؟`;
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
      if (followup?.dueAt && followup.dueAt <= Date.now()) {
        // Claim before sending: retries/duplicate alarms must not spam users.
        // A crash after this write can lose the check-in; delivery isn't exactly-once.
        followup.dueAt = null;
        await this.ctx.storage.put('followup', followup);
        const allowed = this.env.TELEGRAM_ALLOWED_USER_IDS?.trim() || '';
        if (allowed === '*' || allowed.split(',').map(s => s.trim()).includes(String(followup.chatId))) {
          try { await this.send(followup.chatId, FOLLOWUP_TEXT); }
          catch { await this.ctx.storage.delete('followup'); } // blocked bot, unavailable API, etc.
        } else {
          await this.ctx.storage.delete('followup');
        }
      }
      await this.scheduleAlarm();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async scheduleAlarm() {
    const record = await this.ctx.storage.get('session');
    const followup = await this.ctx.storage.get('followup');
    const times = [record?.expiresAt, followup?.dueAt].filter(time => Number.isFinite(time) && time > 0);
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
  async armFollowup(chatId, record) {
    const followup = { chatId, dueAt: Date.now() + FOLLOWUP_DELAY };
    await this.ctx.storage.setAlarm(Math.min(record.expiresAt, followup.dueAt));
    await this.ctx.storage.put('followup', followup);
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
    await this.ctx.storage.setAlarm(Math.min(record.expiresAt, followup?.dueAt || Infinity));
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
        await this.ctx.storage.delete('followup');
        record.messages = [];
        record.lastAt = 0;
        record.introduced = command === '/start';
        await this.persist(record);
        await this.send(chat, command === '/start' ? INTRO : 'سابقهٔ فعال پاک شد و احوال‌پرسی خودکار هم خاموش شد 🌱 پیام‌های تلگرام و سرویس مدل پاک نمی‌شن.');
        return ok();
      }
      if (command === '/followup') {
        await this.armFollowup(chat, record);
        await this.send(chat, 'فعالش کردم 🌱⏰ حدود ۲۴ ساعت بعد از آخرین پیام متنیت، یک بار احوالت رو می‌پرسم 🙂 با پیام جدید زمان از نو حساب می‌شه. لغو: /stop');
        return ok();
      }
      if (command === '/stop') {
        await this.ctx.storage.delete('followup');
        await this.scheduleAlarm();
        await this.send(chat, 'احوال‌پرسی خودکار خاموش شد ✅🌱 هر وقت خواستی دوباره /followup رو بفرست.');
        return ok();
      }
      if (command === '/privacy') { await this.send(chat, CLOUD_PRIVACY); return ok(); }
      if (command === '/help') {
        await this.send(chat, '/start معرفی و شروع دوباره\n/reset پاک‌کردن حافظهٔ فعال گفتگو\n/privacy حریم خصوصی\n/followup فعال‌کردن احوال‌پرسی ۲۴ ساعت بعد\n/stop لغو احوال‌پرسی\n\nفقط متن در چت خصوصی. من هوش مصنوعی‌ام و جایگزین درمانگر یا خدمات اضطراری نیستم.');
        return ok();
      }
      if (!text) { await this.send(chat, 'فعلاً فقط پیام متنی رو می‌تونم بخونم 🌱'); return ok(); }
      if (text.length > 6000) { await this.send(chat, 'لطفاً پیامت رو به بخش‌های کمتر از ۶۰۰۰ کاراکتر تقسیم کن.'); return ok(); }
      if (Date.now() - record.lastAt < 4000) { await this.send(chat, 'لطفاً چند ثانیه صبر کن و دوباره پیام بده.'); return ok(); }
      record.lastAt = Date.now();
      if (await this.ctx.storage.get('followup')) await this.armFollowup(chat, record);
      await this.persist(record);
      if (!record.introduced) {
        await this.send(chat, INTRO);
        record.introduced = true;
        await this.persist(record);
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

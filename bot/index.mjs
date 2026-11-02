import { complete, ConversationStore, DISCLOSURE, PRIVACY, splitMessage } from './core.mjs';
import { formatReply } from './format.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;
if (!token || !apiKey || !model) {
  console.error('Set TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY and OPENROUTER_MODEL in .env.bot. See bot/README.md.');
  process.exit(1);
}
const allowedUsers = new Set((process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const store = new ConversationStore();
const cooldowns = new Map();
const expiry = setInterval(() => {
  store.prune();
  for (const [id, at] of cooldowns) if (Date.now() - at > 60_000) cooldowns.delete(id);
}, 60_000);
expiry.unref();

let running = true;
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { running = false; stop.abort(); });
const delay = ms => new Promise(resolve => {
  if (stop.signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  stop.signal.addEventListener('abort', done, { once: true });
});

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(45_000)]),
  });
  // Do not log response bodies, URLs, tokens or message contents.
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error('Telegram request rejected');
  return data.result;
}

async function send(chatId, text) {
  for (const part of splitMessage(text)) {
    await telegram('sendMessage', { chat_id: chatId, text: part });
  }
}

async function handle(message) {
  // Private chats only: never forward messages from groups to an AI provider.
  if (!message?.from || message.from.is_bot || message.chat?.type !== 'private') return;
  const id = String(message.from.id);
  const chat = message.chat.id;
  if (allowedUsers.size && !allowedUsers.has('*') && !allowedUsers.has(id)) {
    await send(chat, 'این ربات فعلاً فقط برای کاربران مجاز فعاله.');
    return;
  }
  const text = message.text?.trim();
  const command = text?.split(/\s/)[0].split('@')[0].toLowerCase();
  if (command === '/start') {
    store.clear(id);
    await send(chat, DISCLOSURE);
    return;
  }
  if (command === '/reset') {
    store.clear(id);
    cooldowns.delete(id);
    await send(chat, 'سابقهٔ موقت گفتگومون پاک شد 🌱 دوست داری از کجا شروع کنیم؟');
    return;
  }
  if (command === '/followup' || command === '/stop') {
    await send(chat, 'احوال‌پرسی زمان‌بندی‌شده فقط در نسخهٔ Cloudflare فعاله؛ نسخهٔ محلی پیگیری خودکار نداره.');
    return;
  }
  if (command === '/privacy') { await send(chat, PRIVACY); return; }
  if (command === '/help') {
    await send(chat, 'برای گفتگو یک پیام متنی بفرست.\n/start معرفی و شروع دوباره\n/reset پاک‌کردن حافظهٔ گفتگو\n/privacy حریم خصوصی\n\nاین ربات جایگزین درمانگر یا خدمات اضطراری نیست.');
    return;
  }
  if (!text) { await send(chat, 'فعلاً فقط پیام متنی رو می‌تونم بخونم 🌱'); return; }
  if (text.length > 6000) { await send(chat, 'می‌شه پیامت رو در چند بخش کوتاه‌تر بفرستی؟ هر بخش حداکثر ۶۰۰۰ کاراکتر.'); return; }
  if (Date.now() - (cooldowns.get(id) || 0) < 4000) {
    await send(chat, 'لطفاً چند ثانیه صبر کن و دوباره بفرست.');
    return;
  }
  cooldowns.set(id, Date.now());
  const history = [...store.get(id), { role: 'user', content: text }];
  // Disclosure is shown even when the user starts chatting without /start.
  if (history.length === 1) await send(chat, DISCLOSURE);
  await telegram('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  try {
    const answer = await complete({ apiKey, model, messages: history, style: process.env.BOT_STYLE });
    const payloads = formatReply(answer);
    if (!payloads.length) throw new Error('Empty formatted reply');
    for (const payload of payloads) await telegram('sendMessage', { chat_id: chat, ...payload });
    store.save(id, [...history, { role: 'assistant', content: answer }]);
  } catch {
    console.error('AI reply or delivery failed; private details omitted.');
    await send(chat, 'الان نتونستم پاسخ رو آماده یا ارسال کنم. لطفاً کمی بعد دوباره تلاش کن. اگر در خطر فوری هستی، منتظر ربات نمون و با خدمات اضطراری محل یا یک فرد مطمئن تماس بگیر.');
  }
}

// Long polling needs no public URL. Run only one process per bot token.
let offset = 0;
try {
  const webhook = await telegram('getWebhookInfo', {});
  if (webhook.url) throw new Error('Webhook active');
  console.log('Support bot started (private chats, long polling).');
  while (running) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const update of updates) {
        if (!running) break;
        try { await handle(update.message); }
        catch { if (running) console.error('Message handling failed; private details omitted.'); }
        offset = update.update_id + 1;
      }
    } catch {
      if (running) {
        console.error('Telegram polling failed; retrying in 5 seconds.');
        await delay(5000);
      }
    }
  }
} catch {
  console.error('Startup failed. Check network, token and that no webhook is configured. No webhook was changed.');
  process.exitCode = 1;
} finally {
  clearInterval(expiry);
}

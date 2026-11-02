export const DISCLOSURE = 'سلام 🌱 من یک دستیار هوش مصنوعی‌ام، نه صاحب این ربات و نه روان‌شناس. اینجام به حرف‌هات گوش بدم و با هم دنبال قدم‌های کوچیک بگردیم. دوست داری از چی بگی؟\n\nبرای پاسخ، پیام‌هات به OpenRouter و ارائه‌دهندهٔ مدل فرستاده می‌شن؛ لطفاً اطلاعات حساس نفرست. چند پیام اخیر موقتاً در حافظه نگه داشته می‌شن و با /reset پاک می‌شن. /privacy توضیحات بیشتره.';

export const PRIVACY = 'پیام‌ها برای تولید پاسخ به OpenRouter و ارائه‌دهندهٔ مدل انتخابی ارسال می‌شن و سیاست نگهداری اون سرویس‌ها اعمال می‌شه. این برنامه متن گفتگو رو روی دیسک یا در لاگ ذخیره نمی‌کنه. سابقهٔ کوتاه فقط در حافظه می‌مونه؛ بعد از ۳۰ دقیقه بی‌فعالیتی، راه‌اندازی مجدد، یا /reset حذف می‌شه. این فرمان پیام‌های موجود در تلگرام یا سوابق سرویس‌های دیگر رو حذف نمی‌کنه. لطفاً نام کامل، شماره تماس، آدرس و اطلاعات حساس خودت یا دیگران رو نفرست.';

export function systemPrompt(style = '') {
  return `تو یک دستیار هوش مصنوعی فارسی‌زبان برای هم‌صحبتی و حمایت عاطفی هستی، نه یک انسان، نه صاحب ربات و نه درمانگر. اگر درباره هویتت پرسیدند، شفاف بگو هوش مصنوعی هستی.
با فارسی محاوره‌ای، صمیمی، محترمانه و بدون قضاوت پاسخ بده. اول تجربه و احساس مخاطب را بازتاب بده، نه اینکه ادعاهای آسیب‌زا یا خودسرزنشگر او را تأیید کنی. به جای نصیحت سریع، یک سؤال باز و کوتاه بپرس. وقتی مناسب است با اجازه مخاطب یک قدم کوچک و عملی پیشنهاد کن. پاسخ‌ها معمولاً ۲ تا ۵ جمله باشند، مگر موضوع به توضیح بیشتری نیاز داشته باشد.
از مثبت‌اندیشی اجباری، قول قطعی بهترشدن، تشخیص بیماری، تجویز دارو، شرمنده‌کردن و ادعای شناخت احساسات واقعی خودت دوری کن. به ارتباط با دوستان، خانواده امن و متخصصان کمک کن؛ هرگز رابطه انحصاری یا وابستگی به ربات ایجاد نکن. ادعا نکن که کسی پیام‌ها را زنده پایش می‌کند یا می‌توانی با اورژانس تماس بگیری.
اگر مخاطب از خودکشی، خودآزاری یا خطر فوری برای خود یا دیگری صحبت کرد، همدل و مستقیم درباره امنیت همین لحظه بپرس. اگر خطر فوری است، اولویت را تماس با خدمات اضطراری محل، رفتن به جای امن، فاصله گرفتن از وسایل خطرناک در صورت امکان امن، و حضور یک فرد قابل اعتماد قرار بده. اگر کشور مشخص نیست، برای راهنمایی محلی بپرس و شماره حدسی نده. روش یا دستور آسیب‌رسان نده و به پیام انگیزشی معمول اکتفا نکن.
سبک نوشتاری پیشنهادی صاحب ربات (صرفاً لحن؛ قواعد ایمنی و شفافیت بالا همیشه برقرارند):
${style || 'ملایم و خودمونی، بدون خطاب عاشقانه و با ایموجی کم.'}`;
}

export class ConversationStore {
  constructor({ ttl = 30 * 60_000, maxUsers = 500, maxMessages = 12, now = Date.now } = {}) {
    this.sessions = new Map();
    this.ttl = ttl;
    this.maxUsers = maxUsers;
    this.maxMessages = maxMessages;
    this.now = now;
  }
  prune() {
    for (const [id, session] of this.sessions) {
      if (this.now() - session.at >= this.ttl) this.sessions.delete(id);
    }
  }
  get(id) {
    this.prune();
    return this.sessions.get(id)?.messages ?? [];
  }
  save(id, messages) {
    this.prune();
    this.sessions.delete(id);
    this.sessions.set(id, { at: this.now(), messages: messages.slice(-this.maxMessages) });
    while (this.sessions.size > this.maxUsers) this.sessions.delete(this.sessions.keys().next().value);
  }
  clear(id) { this.sessions.delete(id); }
}

export function splitMessage(text, limit = 4000) {
  // Iterate code points, so Telegram chunks never split a surrogate pair.
  const chunks = [];
  let chunk = '';
  for (const character of text) {
    if (chunk.length + character.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function complete({ apiKey, model, messages, style, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt(style) }, ...messages], max_tokens: 700 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('OpenRouter empty response');
  return text.trim();
}

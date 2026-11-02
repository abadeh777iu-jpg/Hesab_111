// One fresh request per eligible weather notification. No user IDs, coordinates,
// API tokens, durable profile, or expired conversation is put into the prompt.
export async function generateWeatherSentence(env, event, session) {
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) return null;
  // Personalize only a coarse tone locally. Never send names, private facts or
  // raw chat text into a push-notification writing request.
  const recent = session?.expiresAt > Date.now() && Array.isArray(session.messages)
    ? session.messages.filter(message => message?.role === 'user' && typeof message.content === 'string').slice(-3) : [];
  const tone = recent.some(message => /خسته|غمگین|ناراحت|ناامید|نگران|سوگ|دلتنگ/.test(message.content)) ? 'gentle' : 'warm';
  const variation = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const response = await (env.fetchImpl || fetch)('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL, temperature: 0.95, max_tokens: 120,
        messages: [{ role: 'system', content:
          'با لحن صمیمی امیر، فقط یک جملهٔ تازه و کوتاه فارسی، حدود ۸ تا ۲۵ کلمه، برای همراهی با خبر هوا بنویس. جمله برای همین مخاطب تولید می‌شود؛ از متن آماده، نقل‌قول مشهور، انتساب به شاعر یا ادعای شناخت شخصی استفاده نکن. یک یا دو ایموجی مناسب کافی است. اگر لحن gentle داده شد، آرام‌تر و بدون فشار برای اقدام بنویس؛ در لحن warm گرم و دلگرم‌کننده باش. هیچ نام، شغل، راز، مشکل، بیماری، جزئیات یا عبارت خصوصی برای مخاطب نساز. از وابسته‌کردن عاطفی، قول موفقیت یا خوب‌شدن حال، قضاوت و مثبت‌اندیشی اجباری دوری کن. اگر بارش شدید است، آرام و مراقبت‌محور باش و کسی را به بیرون‌رفتن دعوت نکن. هیچ پیش‌بینی هوا، زمان، عدد، لینک، هشتگ، نقل‌قول، توضیح اضافه، HTML یا Markdown تولید نکن. چیزی دربارهٔ زندگی یا احساس واقعی مخاطب فرض نکن. فقط خودِ جمله، در یک خط.' },
        { role: 'user', content: JSON.stringify({ weather: event.kind, severe: !!event.severe, variation, tone }) }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return null;
    const sentence = raw.trim();
    // Prevent obvious leaks/markup and reject verbose outputs instead of cutting
    // them into a misleading fragment. Never delay or replace the factual alert.
    if (sentence.length < 8 || sentence.length > 240 || /[\r\n<>\[\]@0-9۰-۹٠-٩]|https?:|www\./iu.test(sentence)) return null;
    return sentence;
  } catch {
    // Raw fetch errors may contain request secrets. Do not log them.
    return null;
  }
}

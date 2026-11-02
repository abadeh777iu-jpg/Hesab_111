const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_INTERVAL = 60 * 60_000;
export const WEATHER_LOOKAHEAD = 3 * 60 * 60_000;
const fa = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 });

export class LiveDataError extends Error {
  constructor(code) { super('Live data unavailable'); this.code = code; }
}

export async function getJson(url, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      // Workers supports only follow/manual, not the browser's error mode.
      // manual keeps API-key URLs from being followed to another host; the
      // non-2xx check below rejects redirects without reading their bodies.
      signal: AbortSignal.timeout(10_000), redirect: 'manual', headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new LiveDataError(['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'NETWORK');
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0;
    throw new LiveDataError(`HTTP_${status}`);
  }
  try { return await response.json(); }
  catch { throw new LiveDataError('BAD_JSON'); }
}

export function weatherFailureMessage(error) {
  // Whitelist codes only; never echo raw exceptions, URLs, tokens or upstream bodies.
  const safe = error instanceof LiveDataError && /^(?:HTTP_[1-5][0-9]{2}|NETWORK|TIMEOUT|BAD_JSON|DATA|STALE)$/.test(error.code)
    ? error.code : 'INTERNAL';
  let explanation;
  if (safe === 'HTTP_429') explanation = 'سرویس هوا فعلاً درخواست‌ها رو محدود کرده؛ این خطا از کلید OpenRouter نیست.';
  else if (safe === 'HTTP_401' || safe === 'HTTP_403') explanation = 'سرویس هوا دسترسی این درخواست رو رد کرده.';
  else if (safe === 'TIMEOUT') explanation = 'پاسخ سرویس هوا به‌موقع نرسید.';
  else if (safe === 'NETWORK') explanation = 'اتصال ربات به سرویس هوا برقرار نشد.';
  else if (safe === 'STALE') explanation = 'زمان دادهٔ سرویس با زمان فعلی سازگار نیست؛ داده رو زنده نمایش نمی‌دم.';
  else if (safe === 'DATA' || safe === 'BAD_JSON') explanation = 'پاسخ سرویس هوا ناقص یا نامعتبره.';
  else if (safe.startsWith('HTTP_')) explanation = 'سرویس هوا درخواست رو با خطا پاسخ داده.';
  else explanation = 'پردازش پاسخ هوا انجام نشد.';
  return `${explanation} 🌱\nکد بررسی: WX_${safe}\nاین کد رو برای مدیر ربات بفرست؛ فعلاً کلیدها رو تغییر نده.`;
}

function coordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export async function findCities(name, fetchImpl = fetch) {
  if (name.length < 2 || name.length > 100) throw new Error('Invalid city');
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name, count: '3', language: 'fa', format: 'json' });
  const data = await getJson(url.href, fetchImpl);
  return (Array.isArray(data.results) ? data.results : []).filter(city => coordinates(city.latitude, city.longitude)).map(city => ({
    name: [city.name, city.admin1, city.country].filter(Boolean).join('، ').slice(0, 200),
    latitude: Math.round(city.latitude * 100) / 100,
    longitude: Math.round(city.longitude * 100) / 100,
    timezone: validTimezone(city.timezone),
  }));
}
function validTimezone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone || 'UTC' }).format(); return zone || 'UTC'; }
  catch { return 'UTC'; }
}
export function localTime(timestamp, timezone = 'UTC') {
  return new Intl.DateTimeFormat('fa-IR', {
    timeZone: validTimezone(timezone), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}
export async function getWeather(city, fetchImpl = fetch) {
  if (!coordinates(city.latitude, city.longitude)) throw new LiveDataError('DATA');
  const url = new URL(WEATHER_URL);
  url.search = new URLSearchParams({
    latitude: String(city.latitude), longitude: String(city.longitude),
    current: 'temperature_2m,weather_code',
    hourly: 'precipitation_probability,rain,snowfall,weather_code',
    forecast_days: '2', timezone: 'auto', timeformat: 'unixtime',
  });
  const data = await getJson(url.href, fetchImpl);
  if (!Number.isFinite(data?.current?.temperature_2m) || !Number.isFinite(data?.current?.time) ||
      !Array.isArray(data?.hourly?.time) || data.hourly.time.length === 0) {
    throw new LiveDataError('DATA');
  }
  if (Math.abs(Date.now() - data.current.time * 1000) > 3 * 60 * 60_000) {
    throw new LiveDataError('STALE');
  }
  return { ...data, timezone: validTimezone(data.timezone || city.timezone) };
}
function precipitationKind(hourly, index) {
  const probability = hourly.precipitation_probability?.[index];
  if (!Number.isFinite(probability) || probability < 60 || probability > 100) return null;
  const snow = hourly.snowfall?.[index];
  const rain = hourly.rain?.[index];
  if (Number.isFinite(snow) && snow >= 0.1) return 'snow';
  if (Number.isFinite(rain) && rain >= 0.1) return 'rain';
  return null;
}
export function upcomingPrecipitation(data, now = Date.now()) {
  const hourly = data.hourly;
  for (let index = 0; index < hourly.time.length; index++) {
    const at = hourly.time[index] * 1000;
    if (!Number.isFinite(at) || at <= now + 5 * 60_000 || at > now + WEATHER_LOOKAHEAD) continue;
    const kind = precipitationKind(hourly, index);
    // Only forecast onsets, not every consecutive wet hour.
    if (!kind || (index > 0 && precipitationKind(hourly, index - 1) === kind)) continue;
    const code = hourly.weather_code?.[index];
    return { at, kind, probability: hourly.precipitation_probability[index],
      severe: [65, 67, 75, 82, 86, 95, 96, 99].includes(code) };
  }
  return null;
}
function weatherDescription(code) {
  if ([0, 1].includes(code)) return 'صاف یا کم‌ابر ☀️';
  if ([2, 3].includes(code)) return 'ابری ☁️';
  if ([45, 48].includes(code)) return 'مه‌آلود 🌫️';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'برفی ❄️';
  if ([95, 96, 99].includes(code)) return 'رعدوبرق ⛈️';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'بارانی 🌧️';
  return 'وضعیت نامشخص';
}
export function weatherSummary(city, data) {
  const event = upcomingPrecipitation(data);
  const next = event ? `\nاحتمال ${event.kind === 'snow' ? 'برف ❄️' : 'باران 🌧️'} حوالی ${localTime(event.at, data.timezone)}: ${fa.format(event.probability)}٪` : '';
  return `${city.name}\n${weatherDescription(data.current.weather_code)} — ${fa.format(data.current.temperature_2m)}°C${next}\nزمان داده: ${localTime(data.current.time * 1000, data.timezone)}\nمنبع: Open-Meteo؛ پیش‌بینی قطعی نیست.`;
}
export function weatherAlert(city, event, timezone, sentence = null, isTest = false) {
  const kind = event.kind === 'snow' ? 'برف ❄️' : 'باران 🌧️';
  const care = event.severe ? 'احتمال بارش شدید؛ قبل از بیرون‌رفتن هشدارهای رسمی رو چک کن ⚠️' : 'اگر بیرون میری، آماده باش 🙂';
  const header = isTest ? '🧪 آزمایشی — این خبر واقعی برف نیست\n\n' : '';
  const footer = isTest
    ? 'زمان و احتمال بالا ساختگی‌اند؛ منبع هوا فراخوانی نشده.\nاین تست هشدارها یا شهر ذخیره‌شده رو تغییر نمی‌ده.'
    : 'منبع: Open-Meteo؛ پیش‌بینی ممکنه تغییر کنه.\nلغو: /weatherstop';
  return `${header}${city.name}: احتمال ${kind} حوالی ${localTime(event.at, timezone)}، ${fa.format(event.probability)}٪\n${care}${sentence ? `\n${sentence}` : ''}\n${footer}`;
}

function positivePrice(quote, unit) {
  const value = typeof quote?.value === 'number' ? quote.value : typeof quote?.value === 'string' && /^\d+(?:\.\d+)?$/.test(quote.value) ? Number(quote.value) : NaN;
  const timestamp = quote?.timestamp;
  const at = Number(timestamp) * 1000;
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Number(timestamp)) || at <= 0 || at > Date.now() + 5 * 60_000) {
    throw new Error('Invalid market quote');
  }
  return { value: unit === 'rial' ? value / 10 : value, at };
}
export function parseMarket(data, unit) {
  if (!['rial', 'toman'].includes(unit)) throw new Error('Price unit not configured');
  return { usd: positivePrice(data.usd_sell, unit), gold: positivePrice(data['18ayar'], unit) };
}
export function marketSummary(quotes, limited = false) {
  const line = (name, quote) => `${name}: ${fa.format(quote.value)} تومان\n🕒 ${localTime(quote.at, 'Asia/Tehran')}${Date.now() - quote.at > 15 * 60_000 ? ' — داده قدیمی؛ لحظه‌ای نیست' : ''}`;
  return `${line('💵 دلار تهران (فروش)', quotes.usd)}\n${line('✨ هر گرم طلای ۱۸ عیار', quotes.gold)}\nمنبع: نوسان؛ ساعت به وقت تهران.${limited ? '\nسهمیه دریافت تازه تمام شده؛ آخرین داده ذخیره‌شده است.' : ''}\nنرخ اعلامی منبعه، نه تضمین قیمت معامله.`;
}
export function isMarketQuestion(text) {
  return /قیمت.{0,25}(?:دلار|طلا)|(?:دلار|طلا).{0,25}(?:چنده|چند شده|قیمت)/u.test(text);
}
export function isWeatherQuestion(text) {
  return /^(?:آب[ ‌]*و[ ‌]*هوا|وضعیت هوا|هوا چطوره|هوا چه طوره)/u.test(text.trim());
}

// One shared feed per deployment, not one paid request per chat. Conservative
// default budget: at most 3 upstream attempts per UTC day (<=93 per month).
export class MarketFeedHandler {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  fetch() {
    const task = this.queue.then(() => this.latest());
    this.queue = task.catch(() => {});
    return task;
  }
  async latest() {
    const reply = (message, status = 200) => new Response(message, { status });
    if (!this.env.NAVASAN_API_KEY || !['rial', 'toman'].includes(this.env.NAVASAN_PRICE_UNIT)) {
      return reply('قیمت زنده هنوز فعال نیست 🌱 مدیر ربات باید کلید نوسان و واحد پاسخ آن را تنظیم کنه؛ من قیمت حدسی نمی‌گم.', 503);
    }
    const cache = await this.ctx.storage.get('prices');
    const usable = cache?.unit === this.env.NAVASAN_PRICE_UNIT && cache.quotes;
    const requested = Number(this.env.NAVASAN_CACHE_MINUTES || 15);
    const ttl = (Number.isFinite(requested) ? Math.max(1, Math.min(1440, requested)) : 15) * 60_000;
    if (usable && Date.now() - cache.fetchedAt < ttl) return reply(marketSummary(cache.quotes));
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const previous = await this.ctx.storage.get('budget');
    const used = previous?.day === day ? previous.used : 0;
    const configured = Number(this.env.NAVASAN_DAILY_LIMIT || 3);
    const limit = Number.isInteger(configured) && configured >= 1 && configured <= 1000 ? configured : 3;
    if (used >= limit) return usable ? reply(marketSummary(cache.quotes, true)) : reply('سهمیهٔ امروزِ منبع قیمت تموم شده؛ فعلاً نرخ تازه در دسترس نیست 🌱', 503);
    await this.ctx.storage.put('budget', { day, used: used + 1 });
    try {
      const url = new URL('https://api.navasan.tech/latest/');
      url.searchParams.set('api_key', this.env.NAVASAN_API_KEY);
      const quotes = parseMarket(await getJson(url.href, this.env.fetchImpl || fetch), this.env.NAVASAN_PRICE_UNIT);
      await this.ctx.storage.put('prices', { quotes, fetchedAt: Date.now(), unit: this.env.NAVASAN_PRICE_UNIT });
      return reply(marketSummary(quotes));
    } catch {
      return reply('الان منبع قیمت پاسخ معتبر نداد؛ نرخ تازه ندارم و حدس نمی‌زنم 🌱', 503);
    }
  }
}

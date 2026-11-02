const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_INTERVAL = 60 * 60_000;
export const WEATHER_LOOKAHEAD = 3 * 60 * 60_000;
const fa = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 });

export async function getJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error('Live data unavailable');
  return response.json();
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
  if (!coordinates(city.latitude, city.longitude)) throw new Error('Invalid coordinates');
  const url = new URL(WEATHER_URL);
  url.search = new URLSearchParams({
    latitude: String(city.latitude), longitude: String(city.longitude),
    current: 'temperature_2m,weather_code',
    hourly: 'precipitation_probability,rain,snowfall,weather_code',
    forecast_days: '2', timezone: 'auto', timeformat: 'unixtime',
  });
  const data = await getJson(url.href, fetchImpl);
  if (!Number.isFinite(data.current?.temperature_2m) || !Number.isFinite(data.current?.time) ||
      Math.abs(Date.now() - data.current.time * 1000) > 3 * 60 * 60_000 || !Array.isArray(data.hourly?.time)) {
    throw new Error('Incomplete or stale forecast');
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
export function weatherAlert(city, event, timezone, sentence = null) {
  const kind = event.kind === 'snow' ? 'برف ❄️' : 'باران 🌧️';
  const care = event.severe ? 'احتمال بارش شدید؛ قبل از بیرون‌رفتن هشدارهای رسمی رو چک کن ⚠️' : 'اگر بیرون میری، آماده باش 🙂';
  return `${city.name}: احتمال ${kind} حوالی ${localTime(event.at, timezone)}، ${fa.format(event.probability)}٪\n${care}${sentence ? `\n${sentence}` : ''}\nمنبع: Open-Meteo؛ پیش‌بینی ممکنه تغییر کنه.\nلغو: /weatherstop`;
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

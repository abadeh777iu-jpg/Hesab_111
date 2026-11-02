import { OUTREACH_NOTICE } from './core.mjs';
import { generateWeatherSentence } from './outreach-text.mjs';
import { findCities, getWeather, upcomingPrecipitation, weatherSummary, weatherAlert, WEATHER_INTERVAL, isWeatherQuestion } from './live-data.mjs';

// Approximate centre of Abadeh, Fars; this is an owner-selected default,
// not a claim about a recipient's actual location.
export const DEFAULT_CITY = Object.freeze({
  name: 'آباده، استان فارس', latitude: 31.16, longitude: 52.65, timezone: 'Asia/Tehran',
});
export const WEATHER_NOTICE = OUTREACH_NOTICE;

const CANDIDATE_TTL = 10 * 60_000;
export function nextWeatherWake(record) {
  const times = [record?.candidatesExpiresAt, record?.alertsEnabled ? record.nextCheckAt : null].filter(time => Number.isFinite(time) && time > 0);
  return times.length ? Math.min(...times) : null;
}

export class WeatherAssistant {
  constructor(storage, env, send, reschedule) {
    this.storage = storage;
    this.env = env;
    this.send = send;
    this.reschedule = reschedule;
  }
  async save(record) {
    await this.storage.put('weather', record);
    await this.reschedule();
  }
  async ensureAutomatic(chat, noticeAlreadyDelivered = false) {
    // Preserve every explicit selection/opt-out, including choices made before
    // automatic defaults were introduced. Never overwrite a custom city.
    if (await this.storage.get('weatherOptOut') || await this.storage.get('weather')) return;
    if (!noticeAlreadyDelivered) await this.send(chat, WEATHER_NOTICE);
    await this.save({ city: { ...DEFAULT_CITY }, chatId: chat, alertsEnabled: true,
      nextCheckAt: Date.now() + 1000, defaultCity: true });
  }
  async stop(forget = false) {
    await this.storage.put('weatherOptOut', true);
    const record = await this.storage.get('weather');
    if (forget) await this.storage.delete('weather');
    else if (record) await this.storage.put('weather', { ...record, alertsEnabled: false, nextCheckAt: null });
    await this.reschedule();
  }
  async handle(text, chat) {
    const [raw, ...args] = text.trim().split(/\s+/);
    const command = raw.split('@')[0].toLowerCase();
    if (!['/city', '/weather', '/alerts', '/weatherstop', '/forgetcity'].includes(command) && !isWeatherQuestion(text)) return false;
    let record = await this.storage.get('weather') || {};
    const fetchImpl = this.env.fetchImpl || fetch;
    if (command === '/forgetcity') {
      await this.stop(true);
      await this.send(chat, 'شهر و تنظیمات هوا پاک شد و هشدارها خاموش شد ✅🌱');
      return true;
    }
    if (command === '/weatherstop') {
      await this.stop();
      await this.send(chat, 'هشدار هوا خاموش شد ✅ برای فعال‌سازی دوباره: /alerts');
      return true;
    }
    if (command === '/city') {
      const name = args.join(' ');
      if (!name) {
        await this.send(chat, `شهر فعلی: ${(record.city || DEFAULT_CITY).name} 🌍\nاگر خواستی تغییرش بدی، مثلاً /city تهران رو بفرست. نام جستجو به Open-Meteo فرستاده می‌شه؛ آدرس دقیق لازم نیست.`);
        return true;
      }
      const normalized = name.replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
      if (/^[1-3]$/.test(normalized)) {
        const city = record.candidatesExpiresAt > Date.now() && record.candidates?.[Number(normalized) - 1];
        if (!city) {
          await this.send(chat, 'انتخاب شهر منقضی یا نامعتبره؛ دوباره اسم شهر رو با /city بفرست 🌱');
          return true;
        }
        // Changing cities never silently moves an active alert subscription.
        await this.save({ city, chatId: chat, alertsEnabled: false, nextCheckAt: null });
        await this.send(chat, `شهرت ثبت شد: ${city.name} 🌍\nهوا: /weather\nهشدار باران و برف: /alerts\nحذف شهر: /forgetcity\nمختصات تقریبی شهر برای پیش‌بینی به Open-Meteo ارسال می‌شه.`);
        return true;
      }
      if (name.length > 100 || name.length < 2) {
        await this.send(chat, 'نام شهر باید بین ۲ تا ۱۰۰ کاراکتر باشه 🌱');
        return true;
      }
      try {
        const candidates = await findCities(name, fetchImpl);
        if (!candidates.length) { await this.send(chat, 'این شهر پیدا نشد؛ اسم انگلیسی یا املای دیگه‌ش رو امتحان کن 🌍'); return true; }
        await this.save({ ...record, candidates, candidatesExpiresAt: Date.now() + CANDIDATE_TTL });
        await this.send(chat, `کدوم شهره؟ 🌍\n${candidates.map((city, index) => `${index + 1}. ${city.name}`).join('\n')}\nبرای تأیید مثلاً /city 1 رو بفرست؛ تا تأیید نکنی شهر عوض نمی‌شه.\nجست‌وجوی شهر: Open-Meteo`);
      } catch {
        await this.send(chat, 'الان سرویس پیدا کردن شهر در دسترس نیست؛ کمی بعد دوباره امتحان کن 🌱');
      }
      return true;
    }
    if (!record.city) record = { ...record, city: { ...DEFAULT_CITY }, defaultCity: true };
    if (command === '/alerts') {
      await this.send(chat, 'هشدار باران و برف فعال شد 🌦️ هر ساعت بررسی می‌کنم؛ اگر شروع بارش در سه ساعت آینده محتمل باشه خبر می‌دم. پیش‌بینی قطعی نیست و خبر دادن قبل از هر بارش تضمین نمی‌شه. لغو: /weatherstop یا /stop');
      await this.storage.delete('weatherOptOut');
      await this.save({ ...record, chatId: chat, alertsEnabled: true, nextCheckAt: Date.now() + 1000 });
      return true;
    }
    try {
      const forecast = await getWeather(record.city, fetchImpl);
      await this.send(chat, weatherSummary(record.city, forecast));
    } catch {
      await this.send(chat, 'الان دادهٔ معتبر هوا ندارم؛ چیزی رو حدس نمی‌زنم 🌱 کمی بعد /weather رو امتحان کن.');
    }
    return true;
  }
  async alarm() {
    const record = await this.storage.get('weather');
    if (!record) return;
    if (record.candidatesExpiresAt && record.candidatesExpiresAt <= Date.now()) {
      delete record.candidates;
      delete record.candidatesExpiresAt;
    }
    if (!record.city && !record.candidates) {
      await this.storage.delete('weather');
      return;
    }
    if (!record.alertsEnabled || !record.nextCheckAt || record.nextCheckAt > Date.now()) {
      await this.storage.put('weather', record);
      return;
    }
    record.nextCheckAt = Date.now() + WEATHER_INTERVAL;
    await this.storage.put('weather', record); // reschedule before upstream I/O
    const allowed = this.env.TELEGRAM_ALLOWED_USER_IDS?.trim() || '';
    if (allowed !== '*' && !allowed.split(',').map(s => s.trim()).includes(String(record.chatId))) {
      await this.storage.put('weatherOptOut', true);
      record.alertsEnabled = false;
      record.nextCheckAt = null;
      await this.storage.put('weather', record);
      return;
    }
    let forecast;
    try { forecast = await getWeather(record.city, this.env.fetchImpl || fetch); }
    catch { return; } // no invented warning and no sensitive network logs
    const event = upcomingPrecipitation(forecast);
    if (!event || (record.lastAlertAt && Date.now() - record.lastAlertAt < 6 * 60 * 60_000) ||
        (record.lastEventAt && Math.abs(event.at - record.lastEventAt) < 6 * 60 * 60_000)) return;
    record.lastAlertAt = Date.now();
    record.lastEventAt = event.at;
    await this.storage.put('weather', record); // claim before sending; no duplicate alarms
    const session = await this.storage.get('session');
    const sentence = await generateWeatherSentence(this.env, event, session);
    try { await this.send(record.chatId, weatherAlert(record.city, event, forecast.timezone, sentence)); }
    catch {
      await this.storage.put('weatherOptOut', true);
      record.alertsEnabled = false;
      record.nextCheckAt = null;
      await this.storage.put('weather', record);
    }
  }
}

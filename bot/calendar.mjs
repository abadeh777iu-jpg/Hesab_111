import occasions from './data/calendar-occasions.json' with { type: 'json' };

export const CALENDAR_ZONE = 'Asia/Tehran';
export const HOLIDAY_URL = 'https://calendar.google.com/calendar/ical/fa.ir.official%23holiday%40group.v.calendar.google.com/public/basic.ics';
const MAX_BYTES = 256 * 1024;
const weekdays = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];
const months = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const ordinals = ['یکم', 'دوم', 'سوم', 'چهارم', 'پنجم', 'ششم', 'هفتم', 'هشتم', 'نهم', 'دهم', 'یازدهم', 'دوازدهم', 'سیزدهم', 'چهاردهم', 'پانزدهم', 'شانزدهم', 'هفدهم', 'هجدهم', 'نوزدهم', 'بیستم', 'بیست‌ویکم', 'بیست‌ودوم', 'بیست‌وسوم', 'بیست‌وچهارم', 'بیست‌وپنجم', 'بیست‌وششم', 'بیست‌وهفتم', 'بیست‌وهشتم', 'بیست‌ونهم', 'سی‌ام', 'سی‌ویکم'];
const fa = new Intl.NumberFormat('fa-IR', { useGrouping: false });
const parts = (locale, now) => Object.fromEntries(new Intl.DateTimeFormat(locale, { timeZone: CALENDAR_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).filter(p => ['year', 'month', 'day'].includes(p.type)).map(p => [p.type, Number(p.value)]));

export function iranToday(now = Date.now()) {
  const solar = parts('en-US-u-ca-persian-nu-latn', now);
  const gregorian = parts('en-US-u-ca-gregory-nu-latn', now);
  // The weekday is computed in Tehran too, never the host/browser timezone.
  const english = new Intl.DateTimeFormat('en-US', { timeZone: CALENDAR_ZONE, weekday: 'short' }).format(now);
  const weekday = weekdays[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(english)];
  const key = `${gregorian.year}${String(gregorian.month).padStart(2, '0')}${String(gregorian.day).padStart(2, '0')}`;
  return { solar, gregorian, key, weekday, sentence: `امروز ${weekday}‌ست، ${ordinals[solar.day - 1]} ${months[solar.month - 1]} ${fa.format(solar.year)} 🌱` };
}

export function isCalendarQuestion(text) {
  const clean = text.normalize('NFKC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\u200c/g, ' ')
    .replace(/[؟?!،,.;؛:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^\/date(?:@[a-z0-9_]+)?$/i.test(clean)) return true;
  const question = clean.replace(/^(?:(?:سلام|امیر|رفیق|راستی)\s+){0,3}/u, '');
  if (!question.includes('امروز')) return false;
  const ending = '(?: ?(?:هست|است|ست|س|ه))?';
  const clauses = [
    `(?:امروز )?چندم(?: ماه)?${ending}`,
    `(?:امروز )?چند ?شنبه${ending}`,
    `(?:امروز )?چه روزی${ending}`,
    '(?:امروز )?چه مناسبتی(?: هست| است| داره|ه)?',
    'تاریخ امروز(?: چیه| چیست| رو بگو)?',
    'مناسبت(?: های)? امروز(?: چیه| چیست| رو بگو)?',
  ].join('|');
  return new RegExp(`^(?:${clauses})(?: (?:و )?(?:${clauses})){0,2}$`, 'u').test(question);
}

export function fixedOccasions(today) {
  return [...occasions.solar.filter(event => event.month === today.solar.month && event.day === today.solar.day),
    ...occasions.gregorian.filter(event => event.month === today.gregorian.month && event.day === today.gregorian.day)].map(event => event.title);
}

// Translate known publisher holiday names, not guessed Hijri dates. All dates
// below come from explicit all-day entries in Google's public Iran calendar.
const holidayNames = {
  'Ashura': 'عاشورا', 'Tassoua': 'تاسوعا', 'Eid-e-Ghadir': 'عید غدیر', 'Eid-e-Ghorban': 'عید قربان',
  'Arbaeen': 'اربعین', 'Eid-e-Fetr Holiday': 'تعطیلی عید فطر', 'Norooz': 'نوروز',
  'Martyrdom of Imam Hasan al-Askari': 'شهادت امام حسن عسکری',
  "Anniversary of Khomeini's Death": 'رحلت امام خمینی',
  'Eid-e-Fetr': 'عید فطر', 'Eid-e-Fetr (Additional Holiday)': 'تعطیلی عید فطر',
  'Norooz Holiday': 'تعطیلات نوروز', 'Norooz (Persian New Year)': 'نوروز', 'Nowruz': 'نوروز',
  "Birthday of Imam Ali and Father's Day": 'ولادت امام علی و روز پدر',
  'Birthday of Prophet Muhammad and Imam Sadeq': 'ولادت پیامبر اسلام و امام صادق',
  'Martyrdom of Hazrat Fatima': 'شهادت حضرت فاطمه', 'Martyrdom of Imam Sadeq': 'شهادت امام صادق',
  'Martyrdom of Imam Ali': 'شهادت امام علی', 'Martyrdom of Imam Reza': 'شهادت امام رضا',
  "Imam Mahdi's birthday": 'ولادت امام مهدی', "Prophet's Ascension": 'مبعث پیامبر اسلام',
  'Demise of Prophet Muhammad and Martyrdom of Imam Hassan': 'رحلت پیامبر اسلام و شهادت امام حسن',
  'Death of Imam Khomeini': 'رحلت امام خمینی', 'Revolt of Khordad 15': 'قیام پانزده خرداد',
  'Oil Nationalization Day': 'روز ملی شدن صنعت نفت', 'Islamic Republic Day': 'روز جمهوری اسلامی',
  'Nature Day': 'روز طبیعت', 'Revolution Day': 'سالروز پیروزی انقلاب اسلامی', 'Election Holiday': 'تعطیلی انتخابات',
};
// Fixed solar holidays use the Persian date table, not Google's occasionally
// equinox-based Gregorian Norooz date (which can differ from Iran's new year).
const fixedHolidayNames = new Set(['Norooz', 'Norooz Holiday', 'Norooz (Persian New Year)', 'Nowruz', 'Oil Nationalization Day', 'Islamic Republic Day', 'Nature Day', 'Revolution Day', 'Islamic Revolution Day', 'Victory of the Islamic Revolution', 'Anniversary of Khomeini\'s Death', 'Death of Imam Khomeini', 'Revolt of Khordad 15']);
const safeTitle = value => value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);

export function parseHolidayCalendar(text, today) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES || !/^BEGIN:VCALENDAR\r?\n/.test(text)) throw new Error('Invalid calendar');
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const blocks = [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/g)];
  if (blocks.length > 3000 || !unfolded.trimEnd().endsWith('END:VCALENDAR')) throw new Error('Invalid calendar');
  const yearDates = new Set(), titles = [];
  for (const [, block] of blocks) {
    if (/^STATUS:CANCELLED\r?$/m.test(block) || /^RRULE:/m.test(block)) continue;
    const date = /^DTSTART;VALUE=DATE:(\d{8})\r?$/m.exec(block)?.[1];
    const rawTitle = /^SUMMARY:(.+?)\r?$/m.exec(block)?.[1];
    if (!date || !rawTitle) continue;
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const stamp = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== iso) continue;
    if (date.startsWith(String(today.gregorian.year))) yearDates.add(date);
    if (date === today.key) {
      const title = safeTitle(rawTitle);
      const tentative = /\s*\(tentative\)$/i.test(title);
      const base = title.replace(/\s*\(tentative\)$/i, '');
      if (base && !fixedHolidayNames.has(base)) titles.push((holidayNames[base] || base) + (tentative ? ' (تاریخ احتمالی در منبع)' : ''));
    }
  }
  // A valid but obsolete/truncated feed must not be mistaken for a complete
  // no-holiday result. Iran's public holiday calendar has well over 10 dates/year.
  if (yearDates.size < 10) throw new Error('Calendar year unavailable');
  return [...new Set(titles)].sort((a, b) => Number(a.includes('تاریخ احتمالی در منبع')) - Number(b.includes('تاریخ احتمالی در منبع'))).slice(0, 10);
}

async function fetchHolidays(fetchImpl, today) {
  const response = await fetchImpl(HOLIDAY_URL, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { Accept: 'text/calendar' } });
  if (!response.ok || !/^text\/calendar(?:;|$)/i.test(response.headers.get('Content-Type') || '') || Number(response.headers.get('Content-Length')) > MAX_BYTES || !response.body) {
    await response.body?.cancel(); throw new Error('Calendar source unavailable');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Large calendar'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return parseHolidayCalendar(new TextDecoder('utf-8', { fatal: true }).decode(bytes), today);
}

export function calendarReply(today, holidays = [], available = false) {
  const events = [];
  const key = value => value.replace(/[\s\u200c\p{P}]/gu, '');
  for (const event of [...holidays, ...fixedOccasions(today)]) {
    if (!events.some(other => key(other).includes(key(event)) || key(event).includes(key(other)))) events.push(event);
  }
  const lines = [today.sentence];
  if (events.length) {
    lines.push(`توی مناسبت‌های ثبت‌شده هم ${events.slice(0, 3).map(title => `«${title}»`).join(' و ')} رو داریم.${events.length > 3 ? ` (${fa.format(events.length - 3)} مورد دیگه هم ثبت شده.)` : ''}`);
  } else lines.push('توی فهرستی که دارم، مناسبتی برای امروز ثبت نشده؛ ممکنه فهرستم کامل نباشه.');
  if (!available) lines.push('تقویم تعطیلات الان در دسترس نیست؛ مناسبت‌های قمری رو حدس نمی‌زنم.');
  lines.push(available ? 'به وقت ایران · منبع: تقویم ثابت + تعطیلات ایرانِ گوگل' : 'به وقت ایران · منبع مناسبت‌ها: تقویم ثابت');
  return lines.join('\n');
}

export class CalendarFeedHandler {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  fetch() {
    const task = this.queue.then(() => this.today());
    this.queue = task.catch(() => {});
    return task;
  }
  async today() {
    let now = Date.now(), today = iranToday(now);
    const cached = await this.ctx.storage.get('calendarDay');
    if (cached?.key === today.key && cached.fetchedAt <= now && now - cached.fetchedAt < 12 * 60 * 60_000) return new Response(calendarReply(today, cached.titles, true));
    const retry = await this.ctx.storage.get('calendarRetry');
    if (retry?.key === today.key && retry.at > now) return new Response(calendarReply(today));
    await this.ctx.storage.put('calendarRetry', { key: today.key, at: now + 15 * 60_000 });
    try {
      const titles = await fetchHolidays(this.env.fetchImpl || fetch, today);
      now = Date.now();
      // If midnight passed during I/O, never label yesterday's occasions today.
      if (iranToday(now).key !== today.key) return new Response(calendarReply(iranToday(now)));
      await this.ctx.storage.put('calendarDay', { key: today.key, titles, fetchedAt: now });
      return new Response(calendarReply(today, titles, true));
    } catch { return new Response(calendarReply(iranToday())); }
  }
}

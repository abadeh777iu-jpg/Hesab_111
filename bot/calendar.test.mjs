import test from 'node:test';
import assert from 'node:assert/strict';
import { iranToday, isCalendarQuestion, fixedOccasions, parseHolidayCalendar, calendarReply, CalendarFeedHandler, HOLIDAY_URL } from './calendar.mjs';

const now = Date.parse('2026-11-04T12:00:00Z');
const event = (date, title, extra = '') => `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${date}\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\n`;
const feed = (extra = '') => 'BEGIN:VCALENDAR\r\n' + Array.from({ length: 12 }, (_, index) => event(`2026${String(index + 1).padStart(2, '0')}01`, 'Test Holiday')).join('') + extra + 'END:VCALENDAR\r\n';
const memory = () => {
  const state = new Map();
  return { state, storage: { get: async key => structuredClone(state.get(key)), put: async (key, value) => state.set(key, structuredClone(value)) } };
};

test('Iran clock renders a friendly Persian weekday, ordinal, month and year', () => {
  const today = iranToday(now);
  assert.deepEqual(today.solar, { month: 8, day: 13, year: 1405 });
  assert.equal(today.key, '20261104');
  assert.equal(today.weekday, 'چهارشنبه');
  assert.equal(today.sentence, 'امروز چهارشنبه‌ست، سیزدهم آبان ۱۴۰۵ 🌱');
  assert.ok(fixedOccasions(today).includes('روز دانش‌آموز'));
});

test('Tehran midnight and Persian new year roll over independently of UTC or browser timezone', () => {
  assert.equal(iranToday(Date.parse('2026-11-04T20:29:59Z')).key, '20261104');
  const after = iranToday(Date.parse('2026-11-04T20:30:00Z'));
  assert.equal(after.key, '20261105'); assert.equal(after.weekday, 'پنجشنبه');
  const last = iranToday(Date.parse('2026-03-20T20:29:59Z'));
  const first = iranToday(Date.parse('2026-03-20T20:30:00Z'));
  assert.equal(last.solar.year, 1404); assert.equal(first.solar.year, 1405);
  assert.ok(first.sentence.includes('یکم فروردین'));
});

test('calendar questions include combined date/weekday/occasion requests but not personal conversation or media', () => {
  for (const text of ['/date', '/date@mybot', 'امروز چندمه؟', 'سلام امیر، امروز چندمه؟', 'امروز چندشنبه‌ست؟', 'امروز چند شنبه است؟', 'امروز چه روزیه؟', 'تاریخ امروز چیه؟', 'امروز چه مناسبتی داره؟', 'مناسبت‌های امروز چیه؟', 'امروز چندمه و چه مناسبتی داره؟', 'امروز چندمه چندشنبهه چه مناسبتیه', 'امروز چندمه چند شنبه هست چه مناسبتی هست', 'امروز چندمه؟ چه روزیه؟ چه مناسبتیه؟']) assert.equal(isCalendarQuestion(text), true, text);
  for (const text of ['امروز حالم بده', 'امروز تولدمه', 'امروز چه روز بدی بود', 'تاریخ ایران', 'تاریخ تولدم رو یادت هست؟', '/voice امروز چندمه', 'امروز چه روزیه حالم خوب نیست', 'فردا چه مناسبتیه']) assert.equal(isCalendarQuestion(text), false, text);
});

test('international occasions use actual Gregorian dates, not approximate solar offsets in leap years', () => {
  for (const timestamp of ['2024-05-01T12:00:00Z', '2026-05-01T12:00:00Z']) assert.ok(fixedOccasions(iranToday(Date.parse(timestamp))).some(title => title.includes('کارگر')));
});

test('all-day holiday dates are matched to Tehran day; folded lines, cancellations and incomplete years are handled safely', () => {
  const today = iranToday(now);
  const data = feed(event(today.key, 'Ashura') + event(today.key, 'Martyrdom of Imam \r\n Ali') + event(today.key, 'Cancelled', 'STATUS:CANCELLED\r\n') + event('20261105', 'Tomorrow'));
  assert.deepEqual(parseHolidayCalendar(data, today), ['عاشورا', 'شهادت امام علی']);
  assert.throws(() => parseHolidayCalendar('BEGIN:VCALENDAR\r\n' + event(today.key, 'Ashura') + 'END:VCALENDAR', today));
  assert.throws(() => parseHolidayCalendar('private HTML error', today));
  assert.throws(() => parseHolidayCalendar('x'.repeat(256 * 1024 + 1), today));
});

test('calendar answer never equates an incomplete/no-event list with no occasions or guesses lunar dates', () => {
  const known = calendarReply(iranToday(now), [], true);
  assert.ok(known.includes('روز دانش‌آموز')); assert.ok(!known.includes('در دسترس نیست'));
  const unavailable = calendarReply(iranToday(now));
  assert.ok(unavailable.includes('چهارشنبه')); assert.ok(unavailable.includes('قمری رو حدس نمی‌زنم'));
  const noEvent = calendarReply({ ...iranToday(now), solar: { month: 12, day: 30, year: 1405 }, gregorian: { month: 2, day: 29, year: 2026 } }, [], true);
  assert.ok(!noEvent.includes('امروز هیچ مناسبتی نیست'));
});

test('shared calendar reads only a fixed public URL with no keys, serializes requests and caches across users', async t => {
  t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory(); let calls = 0;
  const calendar = new CalendarFeedHandler({ storage }, { OPENROUTER_API_KEY: 'private', NAVASAN_API_KEY: 'private', fetchImpl: async (url, options) => {
    calls++; assert.equal(url, HOLIDAY_URL); assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { Accept: 'text/calendar' }); assert.equal(options.body, undefined);
    return new Response(feed(), { headers: { 'Content-Type': 'text/calendar; charset=UTF-8' } });
  } });
  const replies = await Promise.all([calendar.fetch(), calendar.fetch(), calendar.fetch()]);
  for (const reply of replies) assert.ok((await reply.text()).includes('سیزدهم آبان'));
  assert.equal(calls, 1); assert.deepEqual([...state.keys()].sort(), ['calendarDay', 'calendarRetry']);
  assert.ok(!JSON.stringify([...state.values()]).includes('private'));
});

test('source failure keeps the correct date, hides raw error, and backs off without charging any model', async t => {
  t.mock.method(Date, 'now', () => now);
  for (const kind of ['redirect', 'html', 'large', 'network']) {
    let calls = 0; const { storage } = memory();
    const calendar = new CalendarFeedHandler({ storage }, { fetchImpl: async () => {
      calls++;
      if (kind === 'network') throw new Error('secret token in URL');
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
      return new Response(kind === 'large' ? 'x'.repeat(256 * 1024 + 1) : 'secret HTML error', { headers: { 'Content-Type': kind === 'html' ? 'text/html' : 'text/calendar' } });
    } });
    const text = await (await calendar.fetch()).text();
    assert.ok(text.includes('سیزدهم آبان')); assert.ok(text.includes('در دسترس نیست'));
    assert.ok(!text.includes('secret')); assert.ok(!text.includes('evil.test'));
    await calendar.fetch(); assert.equal(calls, 1);
  }
});

test('cached occasions are never carried across Tehran midnight, including midnight during I/O', async t => {
  let clock = Date.parse('2026-11-04T20:29:59Z'); t.mock.method(Date, 'now', () => clock);
  const { storage } = memory(); let calls = 0;
  const calendar = new CalendarFeedHandler({ storage }, { fetchImpl: async () => {
    calls++; clock = Date.parse('2026-11-04T20:30:01Z');
    return new Response(feed(event('20261104', 'Ashura')), { headers: { 'Content-Type': 'text/calendar' } });
  } });
  const text = await (await calendar.fetch()).text();
  assert.ok(text.includes('پنجشنبه')); assert.ok(!text.includes('عاشورا')); assert.ok(!text.includes('روز دانش‌آموز'));
  await calendar.fetch(); assert.equal(calls, 2);
});

test('tentative lunar dates keep their uncertainty and fixed solar holidays cannot drift with Google Gregorian dates', () => {
  const today = iranToday(Date.parse('2025-03-20T12:00:00Z'));
  assert.deepEqual(today.solar, { year: 1403, month: 12, day: 30 });
  const data = feed(event('20250320', 'Norooz') + event('20250320', 'Ashura (tentative)')).replaceAll('2026', '2025');
  const parsed = parseHolidayCalendar(data, today);
  assert.deepEqual(parsed, ['عاشورا (تاریخ احتمالی در منبع)']);
  assert.ok(!calendarReply(today, parsed, true).includes('نوروز'));
});

test('obsolete, invalid-day and recurring feeds cannot count as current-year coverage', () => {
  const today = iranToday(now);
  assert.throws(() => parseHolidayCalendar(feed().replaceAll('2026', '2025'), today));
  const invalid = 'BEGIN:VCALENDAR\r\n' + Array.from({ length: 12 }, (_, i) => event(`2026${String(i + 1).padStart(2, '0')}99`, 'Bad date')).join('') + 'END:VCALENDAR';
  assert.throws(() => parseHolidayCalendar(invalid, today));
  assert.deepEqual(parseHolidayCalendar(feed(event(today.key, 'Ashura', 'RRULE:FREQ=YEARLY\r\n')), today), []);
});

test('failure backoff expires and a twelve-hour cache is refreshed only on demand', async t => {
  let clock = Date.parse('2026-11-03T20:45:00Z'); t.mock.method(Date, 'now', () => clock);
  const { storage } = memory(); let calls = 0;
  const calendar = new CalendarFeedHandler({ storage }, { fetchImpl: async () => {
    if (++calls === 1) throw new Error('Outage');
    return new Response(feed(), { headers: { 'Content-Type': 'text/calendar' } });
  } });
  await calendar.fetch(); clock += 14 * 60000; await calendar.fetch(); assert.equal(calls, 1);
  clock += 60000; await calendar.fetch(); assert.equal(calls, 2);
  clock += 11 * 60 * 60000; await calendar.fetch(); assert.equal(calls, 2);
  clock += 60 * 60000; await calendar.fetch(); assert.equal(calls, 3);
});

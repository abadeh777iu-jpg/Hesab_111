import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherAssistant, nextWeatherWake } from './weather-assistant.mjs';
import { WEATHER_INTERVAL } from './live-data.mjs';

function setup() {
  const state = new Map();
  const sent = [], calls = [];
  const storage = { get: async key => structuredClone(state.get(key)), put: async (key, value) => state.set(key, structuredClone(value)), delete: async key => state.delete(key) };
  const env = { TELEGRAM_ALLOWED_USER_IDS: '42', fetchImpl: async url => {
    calls.push(url);
    if (url.includes('geocoding')) return new Response(JSON.stringify({ results: [
      { name: 'تهران', country: 'ایران', latitude: 35.6892, longitude: 51.389, timezone: 'Asia/Tehran' },
    ] }));
    const hour = Math.floor(Date.now() / 3600000) * 3600;
    return new Response(JSON.stringify({ timezone: 'Asia/Tehran', current: { time: Math.floor(Date.now() / 1000), temperature_2m: 15, weather_code: 3 }, hourly: {
      time: [hour, hour + 3600, hour + 7200], precipitation_probability: [0, 90, 90], rain: [0, 1, 1], snowfall: [0, 0, 0], weather_code: [3, 61, 61],
    } }));
  } };
  const assistant = new WeatherAssistant(storage, env, async (chat, text) => sent.push({ chat, text }), async () => {});
  return { state, sent, calls, env, assistant };
}

test('city selection is explicit and alerts do not activate until requested', async () => {
  const { state, sent, calls, assistant } = setup();
  await assistant.handle('/city تهران', 42);
  assert.equal(state.get('weather').city, undefined);
  assert.equal(state.get('weather').candidates.length, 1);
  assert.ok(sent.at(-1).text.includes('/city 1'));
  await assistant.handle('/city ۱', 42);
  assert.equal(state.get('weather').city.latitude, 35.69);
  assert.equal(state.get('weather').alertsEnabled, false);
  await assistant.handle('/weather', 42);
  assert.ok(sent.at(-1).text.includes('Open-Meteo'));
  assert.ok(sent.at(-1).text.includes('زمان داده'));
  assert.equal(calls.length, 2);
});

test('weather alarms claim events once and have independent persistent scheduling', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { state, sent, calls, assistant } = setup();
  await assistant.handle('/city Tehran', 42);
  await assistant.handle('/city 1', 42);
  await assistant.handle('/alerts', 42);
  assert.equal(nextWeatherWake(state.get('weather')), now + 1000);
  sent.length = 0;
  now += 1000;
  await assistant.alarm();
  await assistant.alarm();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('احتمال باران'));
  assert.ok(sent[0].text.includes('Open-Meteo'));
  assert.equal(state.get('weather').nextCheckAt, now + WEATHER_INTERVAL);
  const before = calls.length;
  now += WEATHER_INTERVAL;
  await assistant.alarm();
  assert.equal(calls.length, before + 1);
  assert.equal(sent.length, 1); // continued rain / cooldown cannot spam
});

test('weather stop disables alerts; forgetting the city deletes coordinates and candidates', async () => {
  const { state, assistant } = setup();
  await assistant.handle('/city Tehran', 42);
  await assistant.handle('/city 1', 42);
  await assistant.handle('/alerts', 42);
  await assistant.handle('/weatherstop', 42);
  assert.equal(state.get('weather').alertsEnabled, false);
  assert.equal(state.get('weather').nextCheckAt, null);
  assert.equal(nextWeatherWake(state.get('weather')), null);
  await assistant.handle('/forgetcity', 42);
  assert.equal(state.has('weather'), false);
});

test('unconfirmed city choices expire and cannot silently change locations', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { state, sent, assistant } = setup();
  await assistant.handle('/city Tehran', 42);
  now += 11 * 60_000;
  await assistant.handle('/city 1', 42);
  assert.ok(sent.at(-1).text.includes('منقضی'));
  await assistant.alarm();
  assert.equal(state.has('weather'), false);
});

test('a provider outage produces no invented warning and leaves a bounded next check', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { state, sent, env, assistant } = setup();
  await assistant.handle('/city Tehran', 42);
  await assistant.handle('/city 1', 42);
  await assistant.handle('/alerts', 42);
  sent.length = 0;
  env.fetchImpl = async () => { throw new Error('network private details'); };
  now += 1000;
  await assistant.alarm();
  assert.equal(sent.length, 0);
  assert.equal(state.get('weather').nextCheckAt, now + WEATHER_INTERVAL);
});

test('revoked access or blocked delivery disables weather outreach', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const mode of ['revoked', 'blocked']) {
    const { state, sent, env, assistant } = setup();
    await assistant.handle('/city Tehran', 42);
    await assistant.handle('/city 1', 42);
    await assistant.handle('/alerts', 42);
    sent.length = 0;
    if (mode === 'revoked') env.TELEGRAM_ALLOWED_USER_IDS = '99';
    else assistant.send = async () => { throw new Error('Telegram 403'); };
    now += 1000;
    await assistant.alarm();
    assert.equal(state.get('weather').alertsEnabled, false);
    assert.equal(state.get('weather').nextCheckAt, null);
    assert.equal(sent.length, 0);
  }
});

test('default weather is Abadeh Fars without a city question or geocoding request', async () => {
  const { sent, calls, state, assistant } = setup();
  await assistant.handle('/weather', 42);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.hostname, 'api.open-meteo.com');
  assert.equal(url.searchParams.get('latitude'), '31.16');
  assert.equal(url.searchParams.get('longitude'), '52.65');
  assert.ok(sent.at(-1).text.startsWith('آباده، استان فارس'));
  assert.ok(!sent.at(-1).text.includes('اول شهرت'));
  assert.equal(state.has('weather'), false); // a manual lookup isn't a location override
});

test('automatic default alerts require a delivered notice and do not repeat it', async () => {
  const { state, sent, calls, assistant } = setup();
  await assistant.ensureAutomatic(42);
  assert.equal(sent.length, 1);
  assert.ok(!/هوا|باران|برف|آباده/.test(sent[0].text));
  assert.ok(sent[0].text.includes('/stop'));
  assert.equal(state.get('weather').city.name, 'آباده، استان فارس');
  assert.equal(state.get('weather').alertsEnabled, true);
  assert.equal(calls.length, 0); // no unnecessary geocoding/forecast on enrollment
  await assistant.ensureAutomatic(42);
  assert.equal(sent.length, 1);
});

test('default enrollment preserves weather opt-outs including forget before any saved city', async () => {
  for (const command of ['/weatherstop', '/forgetcity']) {
    const { state, sent, assistant } = setup();
    await assistant.handle(command, 42);
    assert.equal(state.get('weatherOptOut'), true);
    sent.length = 0;
    await assistant.ensureAutomatic(42, true);
    assert.equal(state.has('weather'), false);
    assert.equal(sent.length, 0);
    await assistant.handle('/alerts', 42);
    assert.equal(state.has('weatherOptOut'), false);
    assert.equal(state.get('weather').city.name, 'آباده، استان فارس');
    assert.equal(state.get('weather').alertsEnabled, true);
  }
});

test('an explicit custom city and its disabled alert preference are never overwritten', async () => {
  const { state, assistant } = setup();
  await assistant.handle('/city تهران', 42);
  await assistant.handle('/city 1', 42);
  await assistant.ensureAutomatic(42, true);
  assert.ok(state.get('weather').city.name.includes('تهران'));
  assert.equal(state.get('weather').alertsEnabled, false);
});

test('failed automatic default disclosure does not enable alerts', async () => {
  const { state, assistant } = setup();
  assistant.send = async () => { throw new Error('delivery failed'); };
  await assert.rejects(assistant.ensureAutomatic(42));
  assert.equal(state.has('weather'), false);
});

test('eligible alerts generate a fresh AI sentence, while duplicate alarms cause no extra model calls', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { state, sent, env, assistant } = setup();
  const original = env.fetchImpl;
  let generations = 0;
  env.OPENROUTER_API_KEY = 'key'; env.OPENROUTER_MODEL = 'model';
  env.fetchImpl = async (url, options) => {
    if (url.includes('openrouter.ai')) {
      generations++;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'گاهی یه نفس آروم، شروع یه حال تازه‌ست 🌱' } }] }));
    }
    return original(url, options);
  };
  await assistant.ensureAutomatic(42, true);
  sent.length = 0;
  now += 1000;
  await assistant.alarm();
  await assistant.alarm();
  assert.equal(generations, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('گاهی یه نفس آروم'));
  assert.ok(sent[0].text.includes('Open-Meteo'));
  assert.ok(!JSON.stringify(state.get('weather')).includes('یه نفس آروم')); // no new permanent profile/text
});

test('a failed AI sentence request cannot suppress a factual weather alert', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { sent, env, assistant } = setup();
  const original = env.fetchImpl;
  env.OPENROUTER_API_KEY = 'key'; env.OPENROUTER_MODEL = 'model';
  env.fetchImpl = async (url, options) => url.includes('openrouter.ai') ? new Response('{}', { status: 503 }) : original(url, options);
  await assistant.ensureAutomatic(42, true);
  sent.length = 0;
  now += 1000;
  await assistant.alarm();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('احتمال باران'));
  assert.ok(!sent[0].text.includes('undefined'));
  assert.ok(!sent[0].text.includes('null'));
});

test('/weather now reports an actionable safe diagnosis instead of the same generic error', async () => {
  const { env, assistant, sent } = setup();
  env.fetchImpl = async () => new Response('sensitive-provider-details', { status: 429 });
  await assistant.handle('/weather', 42);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('WX_HTTP_429'));
  assert.ok(!sent[0].text.includes('sensitive-provider-details'));
});

test('snow preview sends a clearly labeled simulation without touching live city or subscriptions', async () => {
  const { state, sent, calls, assistant } = setup();
  const live = { city: { name: 'custom city', latitude: 20, longitude: 30 }, alertsEnabled: false, nextCheckAt: null };
  state.set('weather', live);
  state.set('weatherOptOut', true);
  state.set('followup', { disabled: true });
  await assistant.previewSnow(42);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, 42);
  assert.ok(sent[0].text.startsWith('🧪 آزمایشی'));
  assert.ok(sent[0].text.includes('این خبر واقعی برف نیست'));
  assert.ok(sent[0].text.includes('آباده، استان فارس'));
  assert.ok(sent[0].text.includes('ساختگی'));
  assert.ok(!sent[0].text.includes('منبع: Open-Meteo'));
  assert.equal(calls.length, 0); // no API key in this fixture; no model or weather calls
  assert.deepEqual(state.get('weather'), live);
  assert.equal(state.get('weatherOptOut'), true);
  assert.deepEqual(state.get('followup'), { disabled: true });
});

test('snow preview generates a fresh sentence once per hour and expires only its own ticket', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { state, sent, env, assistant } = setup();
  let generations = 0;
  env.OPENROUTER_API_KEY = 'key'; env.OPENROUTER_MODEL = 'model';
  env.fetchImpl = async url => {
    assert.equal(new URL(url).hostname, 'openrouter.ai');
    generations++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'گاهی یه شروع تازه، آروم و بی‌صدا از راه می‌رسه ❄️🤍' } }] }));
  };
  await assistant.previewSnow(42);
  await assistant.previewSnow(42);
  assert.equal(generations, 1);
  assert.ok(sent[0].text.includes('یه شروع تازه'));
  assert.ok(sent[1].text.includes('ساعتی یک بار'));
  now += 60 * 60_000;
  await assistant.alarm();
  assert.equal(state.has('snowPreview'), false);
  assert.equal(sent.length, 2); // cleanup is silent, never sends a test on a timer
  await assistant.previewSnow(42);
  assert.equal(generations, 2);
  assert.ok(sent.at(-1).text.startsWith('🧪 آزمایشی'));
});

function cloudyFeed(env) {
  env.fetchImpl = async () => {
    const hour = Math.floor(Date.now() / 3600000) * 3600;
    return Response.json({ timezone: 'Asia/Tehran', current: { time: Math.floor(Date.now() / 1000), temperature_2m: 14, weather_code: 3, cloud_cover: 95 }, hourly: {
      time: [hour, hour + 3600, hour + 7200], weather_code: [3, 3, 3], cloud_cover: [95, 95, 95], rain: [0, 0, 0], snowfall: [0, 0, 0], precipitation_probability: [0, 0, 0],
    } });
  };
}

test('cloud notifications have a daily dedupe claim and a pretty fallback even without model access', async t => {
  let now = Date.UTC(2026, 10, 5, 12, 15); t.mock.method(Date, 'now', () => now);
  const f = setup(); cloudyFeed(f.env); let extras = 0;
  f.assistant.afterAlert = async (_, event) => { assert.equal(event.kind, 'cloud'); extras++; };
  await f.assistant.ensureAutomatic(42, true); now += 1000; await f.assistant.alarm();
  assert.equal(f.sent.length, 1); assert.ok(f.sent[0].text.includes('آسمون ابریه')); assert.ok(f.sent[0].text.includes('هدیه بده'));
  for (let i = 0; i < 23; i++) { now += WEATHER_INTERVAL; await f.assistant.alarm(); }
  assert.equal(f.sent.length, 1); assert.equal(extras, 1);
  now += WEATHER_INTERVAL; await f.assistant.alarm(); assert.equal(f.sent.length, 2);
});

test('a cloud message cannot suppress a newly forecast rain event, and optional media failure never disables weather', async t => {
  let now = Date.UTC(2026, 10, 5, 12, 15); t.mock.method(Date, 'now', () => now);
  const f = setup(), rainy = f.env.fetchImpl; cloudyFeed(f.env);
  f.assistant.afterAlert = async () => { throw new Error('unavailable channel'); };
  await f.assistant.ensureAutomatic(42, true); now += 1000; await f.assistant.alarm();
  f.env.fetchImpl = rainy; now += WEATHER_INTERVAL; await f.assistant.alarm();
  assert.equal(f.sent.length, 2); assert.ok(f.sent[1].text.includes('احتمال باران'));
  assert.equal(f.state.get('weather').alertsEnabled, true);
});

test('membership changes during sentence generation cannot deliver a weather notification or channel extra', async t => {
  let now = Date.UTC(2026, 10, 5, 12, 15); t.mock.method(Date, 'now', () => now);
  const f = setup(); let membership = true, extras = 0;
  const fetchWeather = f.env.fetchImpl; f.env.OPENROUTER_API_KEY = 'fake'; f.env.OPENROUTER_MODEL = 'fake';
  f.env.fetchImpl = async (url, options) => {
    if (url.includes('openrouter.ai')) { membership = false; return Response.json({ choices: [{ message: { content: 'یه لحظه مکث کنار پنجره شاید قشنگ باشه 🌱' } }] }); }
    return fetchWeather(url, options);
  };
  f.assistant.canNotify = async () => membership; f.assistant.afterAlert = async () => { extras++; };
  await f.assistant.ensureAutomatic(42, true); now += 1000; await f.assistant.alarm();
  assert.equal(f.sent.length, 0); assert.equal(extras, 0);
});

test('rain/cloud simulations share the existing once-hourly snow test budget and never send optional channel media', async t => {
  let now = Date.UTC(2026, 10, 5, 12, 15); t.mock.method(Date, 'now', () => now);
  const f = setup(); let extras = 0; f.assistant.afterAlert = async () => { extras++; };
  await f.assistant.previewWeather(42, 'rain');
  assert.ok(f.sent[0].text.startsWith('🧪 آزمایشی')); assert.ok(f.sent[0].text.includes('خبر واقعی باران نیست'));
  await f.assistant.previewWeather(42, 'cloud'); assert.ok(f.sent[1].text.includes('ساعتی یک بار'));
  now += 3600000; await f.assistant.previewWeather(42, 'cloud');
  assert.ok(f.sent[2].text.startsWith('🧪 آزمایشی')); assert.ok(f.sent[2].text.includes('خبر واقعی هوای ابری نیست'));
  assert.ok(!f.sent[2].text.includes('منبع: Open-Meteo')); assert.equal(f.calls.length, 0); assert.equal(extras, 0);
  assert.equal(f.state.has('weather'), false);
});

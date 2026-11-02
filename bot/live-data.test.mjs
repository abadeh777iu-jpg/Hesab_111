import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarket, marketSummary, MarketFeedHandler, getWeather, findCities, upcomingPrecipitation, weatherAlert, isMarketQuestion } from './live-data.mjs';

function quotes() {
  return { usd_sell: { value: '100000', timestamp: Math.floor(Date.now() / 1000) }, '18ayar': { value: '9000000', timestamp: Math.floor(Date.now() / 1000) } };
}
function store() {
  const state = new Map();
  return { state, storage: { get: async key => structuredClone(state.get(key)), put: async (key, value) => state.set(key, structuredClone(value)), delete: async key => state.delete(key) } };
}
function forecast() {
  const hour = Math.floor(Date.now() / 3600000) * 3600;
  return { timezone: 'Asia/Tehran', current: { temperature_2m: 15, time: Math.floor(Date.now() / 1000), weather_code: 3 },
    hourly: { time: [hour, hour + 3600, hour + 7200, hour + 10800, hour + 14400],
      precipitation_probability: [0, 80, 80, 0, 90], rain: [0, 1, 1, 0, 2], snowfall: [0, 0, 0, 0, 0], weather_code: [3, 61, 61, 3, 61] } };
}

test('quotes require explicit units, validate prices/timestamps, and convert rial to toman exactly once', () => {
  assert.equal(parseMarket(quotes(), 'toman').usd.value, 100000);
  assert.equal(parseMarket(quotes(), 'rial').usd.value, 10000);
  assert.throws(() => parseMarket(quotes(), ''), /unit/);
  const bad = quotes(); bad.usd_sell.value = '<b>100</b>';
  assert.throws(() => parseMarket(bad, 'toman'));
  bad.usd_sell.value = '100'; bad.usd_sell.timestamp = Date.now(); // milliseconds are not unix seconds
  assert.throws(() => parseMarket(bad, 'toman'));
  assert.throws(() => parseMarket({}, 'toman'));
});

test('stale prices are labeled rather than represented as live', () => {
  const parsed = parseMarket(quotes(), 'toman');
  parsed.usd.at -= 2 * 3600000;
  const text = marketSummary(parsed, true);
  assert.ok(text.includes('لحظه‌ای نیست'));
  assert.ok(text.includes('داده ذخیره‌شده'));
  assert.ok(text.includes('تهران'));
});

test('a shared serialized market feed collapses concurrent requests and caches results', async () => {
  const { storage } = store();
  let attempts = 0;
  const env = { NAVASAN_API_KEY: 'private-key', NAVASAN_PRICE_UNIT: 'toman', fetchImpl: async url => {
    attempts++;
    assert.equal(new URL(url).hostname, 'api.navasan.tech');
    return new Response(JSON.stringify(quotes()));
  } };
  const feed = new MarketFeedHandler({ storage }, env);
  const responses = await Promise.all([feed.fetch(), feed.fetch(), feed.fetch()]);
  assert.equal(attempts, 1);
  for (const response of responses) {
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes('تومان'));
    assert.ok(!text.includes('private-key'));
  }
});

test('unconfigured feed makes no upstream request; daily attempt budget includes failures', async () => {
  const { storage } = store();
  let attempts = 0;
  const env = { NAVASAN_API_KEY: 'secret', NAVASAN_PRICE_UNIT: 'toman', fetchImpl: async () => {
    attempts++; return new Response('sensitive upstream details', { status: 401 });
  } };
  const unconfigured = new MarketFeedHandler({ storage }, { ...env, NAVASAN_API_KEY: '' });
  assert.equal((await unconfigured.fetch()).status, 503);
  assert.equal(attempts, 0);
  const feed = new MarketFeedHandler({ storage }, env);
  for (let i = 0; i < 4; i++) {
    const response = await feed.fetch();
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('sensitive'));
  }
  assert.equal(attempts, 3);
});

test('forecast onsets require future hours, adequate probability and measurable precipitation', () => {
  const data = forecast();
  const event = upcomingPrecipitation(data);
  assert.equal(event.kind, 'rain');
  assert.equal(event.probability, 80);
  data.hourly.rain = [1, 1, 1, 1, 1];
  data.hourly.precipitation_probability = [80, 80, 80, 80, 80];
  assert.equal(upcomingPrecipitation(data), null); // already raining; don't notify for every hour
  data.hourly.precipitation_probability = [0, 20, 20, 20, 20];
  assert.equal(upcomingPrecipitation(data), null);
  data.hourly.precipitation_probability[1] = 90;
  data.hourly.snowfall[1] = 1;
  data.hourly.weather_code[1] = 75;
  const snow = upcomingPrecipitation(data);
  assert.equal(snow.kind, 'snow');
  assert.equal(snow.severe, true);
  const text = weatherAlert({ name: 'تهران' }, snow, 'Asia/Tehran');
  assert.ok(text.includes('هشدارهای رسمی'));
  assert.ok(text.includes('ممکنه تغییر کنه'));
  assert.ok(text.includes('/weatherstop'));
});

test('weather requests use fixed hosts/rounded city coordinates and reject stale or incomplete data', async () => {
  const city = { name: 'Tehran', latitude: 35.69, longitude: 51.39 };
  const data = await getWeather(city, async url => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api.open-meteo.com');
    assert.equal(parsed.searchParams.get('latitude'), '35.69');
    assert.equal(parsed.searchParams.get('timeformat'), 'unixtime');
    return new Response(JSON.stringify(forecast()));
  });
  assert.equal(data.current.temperature_2m, 15);
  const stale = forecast(); stale.current.time -= 24 * 3600;
  await assert.rejects(getWeather(city, async () => new Response(JSON.stringify(stale))));
  await assert.rejects(getWeather(city, async () => new Response('{}')));
});

test('city search validates and rounds coordinates without picking an ambiguous result', async () => {
  const cities = await findCities('تهران', async url => {
    assert.equal(new URL(url).hostname, 'geocoding-api.open-meteo.com');
    return new Response(JSON.stringify({ results: [
      { name: 'تهران', country: 'ایران', latitude: 35.6892, longitude: 51.3890, timezone: 'Asia/Tehran' },
      { name: 'تهران دیگر', latitude: 35.6, longitude: 51.4, timezone: 'bad/timezone' },
      { name: 'bad', latitude: 999, longitude: 50 },
    ] }));
  });
  assert.equal(cities.length, 2);
  assert.equal(cities[0].latitude, 35.69);
  assert.equal(cities[1].timezone, 'UTC');
  assert.ok(isMarketQuestion('قیمت دلار چنده؟'));
  assert.equal(isMarketQuestion('درباره کارم حرف بزنیم'), false);
});

test('a real Open-Meteo shaped Abadeh response passes validation without weakening freshness', async t => {
  const sample = {
    timezone: 'Asia/Tehran', utc_offset_seconds: 12600,
    current_units: { time: 'unixtime', temperature_2m: '°C', weather_code: 'wmo code' },
    current: { time: 1793645100, interval: 900, temperature_2m: 12.9, weather_code: 2 },
    hourly: { time: [1793644200, 1793647800, 1793651400], precipitation_probability: [0, 0, 0], rain: [0, 0, 0], snowfall: [0, 0, 0], weather_code: [2, 0, 0] },
  };
  t.mock.method(Date, 'now', () => sample.current.time * 1000 + 120000);
  const data = await getWeather({ latitude: 31.16, longitude: 52.65 }, async () => new Response(JSON.stringify(sample)));
  assert.equal(data.current.temperature_2m, 12.9);
  assert.equal(data.timezone, 'Asia/Tehran');
});

test('safe weather diagnostics distinguish HTTP, network, timeout, invalid data and stale data', async () => {
  const { weatherFailureMessage, LiveDataError } = await import('./live-data.mjs');
  const city = { latitude: 31.16, longitude: 52.65 };
  const stale = forecast(); stale.current.time -= 24 * 3600;
  const cases = [
    [async () => new Response('secret upstream body', { status: 429 }), 'HTTP_429'],
    [async () => new Response('secret upstream body', { status: 403 }), 'HTTP_403'],
    [async () => { throw new TypeError('secret-token-in-url'); }, 'NETWORK'],
    [async () => { throw new DOMException('private URL', 'TimeoutError'); }, 'TIMEOUT'],
    [async () => new Response('<html>private response</html>'), 'BAD_JSON'],
    [async () => new Response('{}'), 'DATA'],
    [async () => new Response(JSON.stringify(stale)), 'STALE'],
  ];
  for (const [fetchImpl, expected] of cases) {
    await assert.rejects(getWeather(city, fetchImpl), error => {
      assert.ok(error instanceof LiveDataError);
      const message = weatherFailureMessage(error);
      assert.ok(message.includes(`WX_${expected}`));
      assert.ok(!message.includes('secret'));
      assert.ok(!message.includes('private'));
      return true;
    });
  }
  assert.ok(weatherFailureMessage(new Error('token=secret')).includes('WX_INTERNAL'));
  assert.ok(!weatherFailureMessage(new LiveDataError('secret')).includes('secret'));
});

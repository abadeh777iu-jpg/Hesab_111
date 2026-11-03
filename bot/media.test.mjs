import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMediaRequest, generateImage, generateSpeech, uploadMedia, speechText,
  MediaBudgetHandler, mediaFailureMessage, nextMediaDay,
} from './media.mjs';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const imageJSON = () => Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64'), media_type: 'image/png' }] });

test('media intent requires an explicit command or anchored request, never mere mentions', () => {
  for (const text of ['/image a snowy cabin', '/image@my_bot a snowy cabin']) {
    assert.deepEqual(parseMediaRequest(text), { kind: 'image', prompt: 'a snowy cabin' });
  }
  assert.deepEqual(parseMediaRequest('برام یه عکس کلبه برفی بساز'), { kind: 'image', prompt: 'کلبه برفی' });
  assert.deepEqual(parseMediaRequest('تصویر بساز: کلبه برفی'), { kind: 'image', prompt: 'کلبه برفی' });
  assert.deepEqual(parseMediaRequest('/voice'), { kind: 'voice', prompt: '' });
  assert.deepEqual(parseMediaRequest('با ویس جواب بده، چطور شروع کنم؟'), { kind: 'voice', prompt: 'چطور شروع کنم؟' });
  assert.deepEqual(parseMediaRequest('چطور شروع کنم؟ با ویس جواب بده'), { kind: 'voice', prompt: 'چطور شروع کنم؟' });
  for (const text of ['می‌تونی عکس بسازی؟', 'ویس دوست ندارم', 'عکس نساز', 'دیروز گفت عکس برف بساز', '/imagefoo', '/voiceover']) {
    assert.equal(parseMediaRequest(text), null, text);
  }
});

test('image uses the dedicated fixed OpenRouter endpoint and returns actual validated bytes', async () => {
  let called = 0;
  const file = await generateImage({ OPENROUTER_API_KEY: 'private', fetchImpl: async (url, options) => {
    called++;
    assert.equal(url, 'https://openrouter.ai/api/v1/images');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer private');
    const body = JSON.parse(options.body);
    assert.equal(body.prompt, 'کلبه برفی');
    assert.equal(body.n, 1);
    assert.equal(body.resolution, '1K');
    assert.equal(body.model, 'bytedance-seed/seedream-4.5');
    return imageJSON();
  } }, 'کلبه برفی');
  assert.equal(called, 1);
  assert.deepEqual(file.bytes, png);
  assert.equal(file.type, 'image/png');
});

test('URL-only, malformed, unsafe image formats and redirect replies never get fetched', async () => {
  for (const reply of [
    () => Response.json({ data: [{ url: 'https://private.internal/image' }] }),
    () => Response.json({ data: [{ b64_json: btoa('<svg>bad</svg>'), media_type: 'image/svg+xml' }] }),
    () => Response.json({ data: [{ b64_json: 'not base64' }] }),
    () => Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64'), media_type: 'image/jpeg' }] }),
    () => new Response(null, { status: 302, headers: { Location: 'https://leak.invalid' } }),
    () => new Response('private body', { status: 402 }),
  ]) {
    let calls = 0;
    await assert.rejects(generateImage({ OPENROUTER_API_KEY: 'key', fetchImpl: async () => { calls++; return reply(); } }, 'snow'));
    assert.equal(calls, 1);
  }
  assert.ok(!mediaFailureMessage(new Error('https://secret-token')).includes('secret-token'));
  assert.ok(mediaFailureMessage({ code: 'HTTP_402' }).includes('اعتبار'));
});

test('bounded streaming reads reject oversized replies even without Content-Length', async () => {
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); },
  }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(generateImage({ OPENROUTER_API_KEY: 'key', fetchImpl }, 'snow'), { code: 'SIZE' });
});

test('speech requests a short synthetic Persian preset as MP3, not a cloned voice', async () => {
  const answer = '[OPINION]به نظرم یه قدم بردار 🌱[/OPINION]';
  assert.equal(speechText(answer), 'به نظرم یه قدم بردار');
  assert.equal(speechText('الف'.repeat(900)).length, 600);
  const file = await generateSpeech({ OPENROUTER_API_KEY: 'key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
    assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body);
    assert.equal(body.input, 'به نظرم یه قدم بردار');
    assert.equal(body.voice, 'onyx');
    assert.equal(body.response_format, 'mp3');
    assert.ok(!body.input_references);
    assert.ok(body.instructions.includes('Persian'));
    return new Response(Uint8Array.from([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
  } }, answer);
  assert.equal(file.type, 'audio/mpeg');
  for (const response of [
    new Response('not mp3', { headers: { 'Content-Type': 'audio/mpeg' } }),
    Response.json({ error: 'private' }),
    new Response(null, { status: 204 }),
    new Response('too large', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(6 * 1024 * 1024) } }),
  ]) {
    await assert.rejects(generateSpeech({ OPENROUTER_API_KEY: 'key', fetchImpl: async () => response }, 'سلام'));
  }
});

test('uploads use multipart bytes with fixed method, authenticated recipient and AI labels', async () => {
  for (const kind of ['image', 'voice']) {
    await uploadMedia({ TELEGRAM_BOT_TOKEN: 'token', fetchImpl: async (url, options) => {
      assert.equal(url, `https://api.telegram.org/bottoken/${kind === 'image' ? 'sendPhoto' : 'sendVoice'}`);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers, undefined); // runtime supplies multipart boundary
      assert.equal(options.body.get('chat_id'), '42');
      const caption = options.body.get('caption');
      assert.ok(caption.includes(kind === 'image' ? 'هوش مصنوعی' : 'صدای مصنوعی'));
      const attachment = options.body.get(kind === 'image' ? 'photo' : 'voice');
      assert.deepEqual(new Uint8Array(await attachment.arrayBuffer()), png);
      return Response.json({ ok: true });
    } }, 42, kind, { bytes: png, filename: 'test.png', type: 'image/png' });
  }
  await assert.rejects(uploadMedia({ TELEGRAM_BOT_TOKEN: 'token', fetchImpl: async () => Response.json({ ok: false }) }, 42, 'image', { bytes: png, filename: 'x.png', type: 'image/png' }));
});

function budgetSetup() {
  const data = new Map();
  let alarm;
  const handler = new MediaBudgetHandler({ storage: {
    get: async key => structuredClone(data.get(key)), put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async key => data.delete(key), setAlarm: async at => { alarm = at; },
  } });
  const reserve = kind => handler.fetch(new Request('https://budget.internal', { method: 'POST', body: JSON.stringify({ kind }) }));
  return { data, handler, reserve, alarmAt: () => alarm };
}

test('one shared serialized budget prevents concurrent overspend and stores no users or prompts', async t => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  const { reserve, data, alarmAt } = budgetSetup();
  const images = await Promise.all(Array.from({ length: 10 }, () => reserve('image')));
  assert.equal(images.filter(reply => reply.ok).length, 3);
  const voices = await Promise.all(Array.from({ length: 15 }, () => reserve('voice')));
  assert.equal(voices.filter(reply => reply.ok).length, 10);
  assert.deepEqual(data.get('budget'), { image: 3, voice: 10, expiresAt: nextMediaDay() });
  assert.equal(alarmAt(), nextMediaDay());
  assert.equal((await reserve('__proto__')).status, 400);
});

test('global budget recovers after object recreation, resets at UTC day boundary, and cleans up silently', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { reserve, data, handler } = budgetSetup();
  await reserve('image');
  const recreated = new MediaBudgetHandler(handler.ctx);
  const response = () => recreated.fetch(new Request('https://budget.internal', { method: 'POST', body: JSON.stringify({ kind: 'image' }) }));
  assert.equal((await response()).status, 200);
  assert.equal((await response()).status, 200);
  assert.equal((await response()).status, 429);
  now = nextMediaDay(now);
  assert.equal((await response()).status, 200);
  assert.equal(data.get('budget').image, 1);
  now = nextMediaDay(now);
  await recreated.alarm();
  assert.equal(data.has('budget'), false);
});

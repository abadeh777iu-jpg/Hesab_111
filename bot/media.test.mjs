import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWav } from './fixtures/audio.mjs';
import {
  parseMediaRequest, generateImage, generateSpeech, uploadMedia, speechText,
  MediaBudgetHandler, mediaFailureMessage, nextMediaDay, classifyFreeAIRejection, openRouterSpeechConfiguration, DEFAULT_SPEECH_MODEL,
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
  const file = await generateImage({ MEDIA_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'private', fetchImpl: async (url, options) => {
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
    await assert.rejects(generateImage({ MEDIA_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'key', fetchImpl: async () => { calls++; return reply(); } }, 'snow'));
    assert.equal(calls, 1);
  }
  assert.ok(!mediaFailureMessage(new Error('https://secret-token')).includes('secret-token'));
  assert.ok(mediaFailureMessage({ code: 'HTTP_402' }).includes('اعتبار'));
});

test('bounded streaming reads reject oversized replies even without Content-Length', async () => {
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); },
  }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(generateImage({ MEDIA_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'key', fetchImpl }, 'snow'), { code: 'SIZE' });
});

test('speech requests a short synthetic Persian preset as MP3, not a cloned voice', async () => {
  const answer = '[OPINION]به نظرم یه قدم بردار 🌱[/OPINION]';
  assert.equal(speechText(answer), 'به نظرم یه قدم بردار');
  assert.equal(speechText('الف'.repeat(900)).length, 600);
  const file = await generateSpeech({ MEDIA_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
    assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body);
    assert.equal(body.input, 'به نظرم یه قدم بردار');
    assert.equal(body.voice, 'Charon');
    assert.equal(body.response_format, 'pcm');
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
    await assert.rejects(generateSpeech({ MEDIA_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'key', fetchImpl: async () => response }, 'سلام'));
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
  const images = await Promise.all(Array.from({ length: 20 }, () => reserve('image')));
  assert.equal(images.filter(reply => reply.ok).length, 10);
  const voices = await Promise.all(Array.from({ length: 15 }, () => reserve('voice')));
  assert.equal(voices.filter(reply => reply.ok).length, 10);
  assert.deepEqual(data.get('budget'), { image: 10, voice: 10, expiresAt: nextMediaDay() });
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
  for (let i = 0; i < 9; i++) assert.equal((await response()).status, 200);
  assert.equal((await response()).status, 429);
  now = nextMediaDay(now);
  assert.equal((await response()).status, 200);
  assert.equal(data.get('budget').image, 1);
  now = nextMediaDay(now);
  await recreated.alarm();
  assert.equal(data.has('budget'), false);
});

test('Free.ai requires its own key and a compatible explicit voice when overriding the default model', async () => {
  let calls = 0;
  const env = { OPENROUTER_API_KEY: 'keep-chat-key', fetchImpl: async () => { calls++; throw new Error('Should not call'); } };
  await assert.rejects(generateImage(env, 'snow'), { code: 'FREEAI_KEY' });
  await assert.rejects(generateSpeech({ ...env, MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'free-key', FREEAI_TTS_MODEL: 'custom-model' }, 'سلام'), { code: 'FREEAI_VOICE' });
  assert.equal(calls, 0); // never falls back to the chat key or an English voice
});

test('Free.ai image adapter uses its own key and documented endpoint, then downloads without any credentials', async () => {
  const requests = [];
  const file = await generateImage({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'free-secret', OPENROUTER_API_KEY: 'chat-secret', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'manual');
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.free.ai/v1/image/generate/');
      assert.equal(options.headers.Authorization, 'Bearer free-secret');
      assert.deepEqual(JSON.parse(options.body), { prompt: 'کلبه برفی', model: 'sdxl', aspect_ratio: '1:1' });
      return Response.json({ image_url: 'https://api.free.ai/static/outputs/snow.png' });
    }
    assert.equal(url, 'https://api.free.ai/static/outputs/snow.png');
    assert.deepEqual(options.headers, { Accept: 'image/png,image/jpeg' });
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  } }, 'کلبه برفی');
  assert.equal(requests.length, 2);
  assert.deepEqual(file.bytes, png);
  assert.ok(!JSON.stringify(requests).includes('chat-secret'));
});

test('Free.ai speech adapter sends only clean response text with explicit Persian language and chosen voice', async () => {
  const file = await generateSpeech({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'free-key', FREEAI_TTS_MODEL: 'configured-persian-model', FREEAI_TTS_VOICE: 'configured-persian-voice', fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.free.ai/v1/tts/');
      assert.equal(options.headers.Authorization, 'Bearer free-key');
      assert.deepEqual(JSON.parse(options.body), {
        text: 'سلام رفیق', model: 'configured-persian-model', voice: 'configured-persian-voice', language: 'fa', format: 'mp3',
      });
      return Response.json({ audio_url: '/static/outputs/voice.mp3' });
    }
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(url, 'https://api.free.ai/static/outputs/voice.mp3');
    return new Response(Uint8Array.from([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
  } }, '[OPINION]سلام رفیق 🌱[/OPINION]');
  assert.equal(file.type, 'audio/mpeg');
});

test('Free.ai asset URLs cannot target arbitrary hosts, private IPs, userinfo, non-output routes or redirects', async () => {
  for (const url of [
    'http://api.free.ai/static/outputs/x.png',
    'https://api.free.ai.evil.test/static/outputs/x.png',
    'https://127.0.0.1/static/outputs/x.png',
    'https://api.free.ai:444/static/outputs/x.png',
    'https://user:password@api.free.ai/static/outputs/x.png',
    'https://api.free.ai/v1/image/generate/',
    'https://api.free.ai/static/outputs/%2e%2e/secret.png',
    'https://api.free.ai/static/outputs/x.png#fragment',
    'https://free.ai/static/outputs/a.svg',
    'data:image/png;base64,aaaa',
  ]) {
    let calls = 0;
    await assert.rejects(generateImage({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'free-key', fetchImpl: async () => {
      calls++; return Response.json({ image_url: url });
    } }, 'snow'), { code: 'ASSET_URL' });
    assert.equal(calls, 1, url); // no download request, no OpenRouter fallback
  }
  let calls = 0;
  await assert.rejects(generateImage({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'free-key', fetchImpl: async () => {
    calls++;
    if (calls === 1) return Response.json({ image_url: '/static/outputs/x.png' });
    return new Response(null, { status: 302, headers: { Location: 'https://private.invalid/secret' } });
  } }, 'snow'), { code: 'HTTP_302' });
  assert.equal(calls, 2);
});

test('Free.ai asset downloads have a byte cap and reject mismatched image signatures', async () => {
  for (const response of [
    new Response('not a PNG', { headers: { 'Content-Type': 'image/png' } }),
    new Response('private', { headers: { 'Content-Type': 'text/html' } }),
    new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(6 * 1024 * 1024) } }),
  ]) {
    let calls = 0;
    await assert.rejects(generateImage({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'key', fetchImpl: async () => {
      calls++; return calls === 1 ? Response.json({ url: 'https://free.ai/static/outputs/x.png' }) : response;
    } }, 'snow'));
    assert.equal(calls, 2);
  }
});

test('Free.ai rejects malformed WAV or non-Opus OGG instead of relabeling files', async () => {
  for (const [type, bytes] of [
    ['audio/wav', new TextEncoder().encode('RIFF WAV')],
    ['audio/ogg', new TextEncoder().encode('OggS vorbis data')],
    ['audio/mp4', new TextEncoder().encode('not an m4a file')],
  ]) {
    let calls = 0;
    await assert.rejects(generateSpeech({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'key', FREEAI_TTS_MODEL: 'model', FREEAI_TTS_VOICE: 'voice', fetchImpl: async () => {
      calls++; return calls === 1 ? Response.json({ audio_url: '/static/outputs/test.wav' }) : new Response(bytes, { headers: { 'Content-Type': type } });
    } }, 'سلام'), { code: 'AUDIO_FORMAT' });
  }
});

test('Free.ai accepts supported Opus and M4A voice containers without a conversion API call', async () => {
  for (const [type, bytes, expected] of [
    ['audio/ogg', new TextEncoder().encode('OggS fake page OpusHead'), 'audio/ogg'],
    ['audio/mp4', Uint8Array.from([0, 0, 0, 24, ...new TextEncoder().encode('ftypM4A ')]), 'audio/mp4'],
  ]) {
    let calls = 0;
    const file = await generateSpeech({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'key', FREEAI_TTS_MODEL: 'model', FREEAI_TTS_VOICE: 'voice', fetchImpl: async () => {
      calls++; return calls === 1 ? Response.json({ audio_url: '/static/outputs/test.ogg' }) : new Response(bytes, { headers: { 'Content-Type': type } });
    } }, 'سلام');
    assert.equal(file.type, expected);
    assert.equal(calls, 2);
  }
});


test('Free.ai voice defaults to Persian Piper and converts returned WAV locally with no paid conversion call', async () => {
  let calls = 0;
  const file = await generateSpeech({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'free-key', fetchImpl: async (url, options) => {
    calls++;
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.free.ai/v1/tts/');
      assert.deepEqual(JSON.parse(options.body), {
        text: 'سلام رفیق', model: 'piper', voice: 'fa_IR-amir-medium', language: 'fa', format: 'mp3',
      });
      return Response.json({ audio_url: '/static/outputs/voice.wav' });
    }
    assert.equal(url, 'https://api.free.ai/static/outputs/voice.wav');
    assert.equal(options.headers.Authorization, undefined);
    return new Response(makeWav(), { headers: { 'Content-Type': 'audio/wav' } });
  } }, 'سلام رفیق');
  assert.equal(calls, 2);
  assert.equal(file.type, 'audio/mpeg');
  assert.equal(file.filename, 'amir-voice.mp3');
  assert.ok(file.bytes.length > 100);
  assert.equal(file.bytes[0], 255);
  assert.equal(file.bytes[1] & 224, 224);
});

test('Free.ai 400 is not blamed on voice without explicit evidence; only fixed diagnostic categories escape', () => {
  const cases = [
    [{ error: 'Unsupported voice: private-value sk-free-secret' }, 'HTTP_400_VOICE'],
    [{ error: { message: 'Unknown TTS model: private-model' } }, 'HTTP_400_MODEL'],
    [{ error: { error: 'Language is not supported' } }, 'HTTP_400_LANGUAGE'],
    [{ error: { code: 'unsupported_format' } }, 'HTTP_400_FORMAT'],
    [{ message: 'Invalid input' }, 'HTTP_400_INPUT'],
    [{ error: 'Voice processing failed while checking model' }, 'HTTP_400'],
    [{ error: 'Invalid voice or unknown model' }, 'HTTP_400'],
    [{ error: 'https://example.invalid/sk-free-private body and prompt' }, 'HTTP_400'],
  ];
  for (const [body, expected] of cases) {
    const code = classifyFreeAIRejection(400, body);
    assert.equal(code, expected);
    const text = mediaFailureMessage({ code });
    assert.ok(!text.includes('private'));
    assert.ok(!text.includes('sk-free-'));
    assert.ok(!text.includes('https://'));
    assert.ok(text.includes(`MEDIA_${expected}`));
  }
  assert.equal(classifyFreeAIRejection(422, { detail: [{ loc: ['body', 'voice'], type: 'missing', input: 'private' }] }), 'HTTP_422_VOICE');
  assert.equal(classifyFreeAIRejection(422, { detail: [{ loc: ['body', 'private-field'], type: 'missing' }] }), 'HTTP_422');
  assert.equal(classifyFreeAIRejection(403, { error: 'Unsupported voice' }), 'HTTP_403');
});

test('bounded Free.ai error-body inspection classifies rejection without retrying or retaining secrets', async () => {
  let calls = 0;
  const env = { MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'free-key', fetchImpl: async () => {
    calls++;
    return Response.json({ error: { error: 'Unknown voice: sk-free-do-not-display', private_context: 'user transcript' } }, { status: 400 });
  } };
  await assert.rejects(generateSpeech(env, 'سلام'), error => {
    assert.equal(error.code, 'HTTP_400_VOICE');
    assert.equal(error.message, 'Media request failed');
    assert.ok(!JSON.stringify(error).includes('sk-free-do-not-display'));
    return true;
  });
  assert.equal(calls, 1);
  for (const response of [new Response('bad json', { status: 400 }), new Response('x'.repeat(17 * 1024), { status: 400 }), new Response(null, { status: 400 })]) {
    await assert.rejects(generateSpeech({ MEDIA_VOICE_PROVIDER: 'freeai', FREEAI_API_KEY: 'key', fetchImpl: async () => response }, 'سلام'), { code: 'HTTP_400' });
  }
});

test('voice defaults to OpenRouter independently of legacy image provider and uses only its key', async () => {
  let calls = 0;
  const file = await generateSpeech({ MEDIA_PROVIDER: 'freeai', OPENROUTER_API_KEY: 'chat-key', FREEAI_API_KEY: 'free-key', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
    assert.equal(options.headers.Authorization, 'Bearer chat-key');
    assert.ok(!JSON.stringify(options).includes('free-key'));
    assert.equal(JSON.parse(options.body).voice, 'Charon');
    return new Response(Uint8Array.from([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
  } }, 'سلام رفیق');
  assert.equal(calls, 1);
  assert.equal(file.type, 'audio/mpeg');
  await assert.rejects(generateSpeech({ FREEAI_API_KEY: 'free-key', fetchImpl: async () => { throw new Error('No fallback'); } }, 'سلام'), { code: 'OPENROUTER_KEY' });
});

test('OpenRouter voice default matches the checked live catalog and migrates only the retired example settings', async () => {
  const { readFile } = await import('node:fs/promises');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/openrouter-speech.json', import.meta.url), 'utf8'));
  const defaults = openRouterSpeechConfiguration({});
  assert.equal(defaults.model, snapshot.catalogEntry.id);
  assert.ok(snapshot.catalogEntry.supported_voices.includes(defaults.voice));
  assert.equal(defaults.response_format, snapshot.documentedGeminiResponseFormat);
  assert.deepEqual(openRouterSpeechConfiguration({ OPENROUTER_SPEECH_MODEL: 'openai/gpt-4o-mini-tts-2025-12-15', OPENROUTER_VOICE: 'onyx' }), defaults);
  assert.equal(openRouterSpeechConfiguration({ OPENROUTER_VOICE: 'Kore' }).voice, 'Kore');
  assert.deepEqual(openRouterSpeechConfiguration({ OPENROUTER_SPEECH_MODEL: 'custom/voice-model', OPENROUTER_VOICE: 'custom-voice' }), { model: 'custom/voice-model', voice: 'custom-voice', response_format: 'mp3' });
  assert.throws(() => openRouterSpeechConfiguration({ OPENROUTER_SPEECH_MODEL: DEFAULT_SPEECH_MODEL, OPENROUTER_VOICE: 'onyx' }), { code: 'OR_VOICE_CONFIG' });
});

test('OpenRouter Gemini PCM is converted to MP3 locally with one generation call and no provider fallback', async () => {
  let calls = 0;
  const file = await generateSpeech({ OPENROUTER_API_KEY: 'key', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
    const body = JSON.parse(options.body);
    assert.equal(body.model, DEFAULT_SPEECH_MODEL);
    assert.equal(body.voice, 'Charon');
    assert.equal(body.response_format, 'pcm');
    assert.ok(body.instructions.includes('Persian'));
    return new Response(makeWav({ sampleRate: 24000 }).subarray(44), { headers: { 'Content-Type': 'audio/pcm;rate=24000;channels=1' } });
  } }, 'سلام رفیق');
  assert.equal(calls, 1);
  assert.equal(file.type, 'audio/mpeg');
  assert.equal(file.bytes[0], 255);
  assert.ok(file.bytes.length > 100);
  for (const contentType of ['audio/pcm;rate=48000', 'audio/pcm;channels=2', 'audio/pcm; rate = "48000"', 'audio/pcm;bits=32', 'audio/pcm;rate=24000;rate=48000']) {
    await assert.rejects(generateSpeech({ OPENROUTER_API_KEY: 'key', fetchImpl: async () => new Response(new Uint8Array(100), { headers: { 'Content-Type': contentType } }) }, 'سلام'), { code: 'AUDIO_FORMAT' });
  }
});

test('OpenRouter 400 diagnostics identify the provider without exposing its raw error or retrying', async () => {
  let calls = 0;
  await assert.rejects(generateSpeech({ OPENROUTER_API_KEY: 'key', fetchImpl: async () => {
    calls++;
    return Response.json({ error: { message: 'Unknown model: private-value key-secret' } }, { status: 400 });
  } }, 'سلام'), error => {
    assert.equal(error.code, 'OR_HTTP_400_MODEL');
    const text = mediaFailureMessage(error);
    assert.ok(text.includes('OpenRouter'));
    assert.ok(!text.includes('Free.ai'));
    assert.ok(!text.includes('key-secret'));
    return true;
  });
  assert.equal(calls, 1);
});


test('Gemini WAV-wrapped unary audio is not interpreted as raw PCM samples', async () => {
  const wav = makeWav({ sampleRate: 24000 });
  const { wavToMp3 } = await import('./audio.mjs');
  const file = await generateSpeech({ OPENROUTER_API_KEY: 'key', fetchImpl: async () => new Response(wav, { headers: { 'Content-Type': 'audio/pcm' } }) }, 'سلام');
  assert.deepEqual(file.bytes, wavToMp3(wav));
});

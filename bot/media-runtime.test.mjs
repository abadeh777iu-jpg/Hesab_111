import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { makeWav } from './fixtures/audio.mjs';

// Exercise actual Workers binary decoding + multipart upload, not Node-only mocks.
// Both upstream services are local fake bindings: no tokens or live paid calls.
for (const provider of ['openrouter', 'freeai', 'mixed', 'laozhang']) test(`Workers ${provider} media runtime decodes files and uploads multipart attachments`, async t => {
  const helperPath = fileURLToPath(new URL('./media.mjs', import.meta.url));
  const entryPath = fileURLToPath(new URL('./media-runtime-entry.mjs', import.meta.url));
  const audioPath = fileURLToPath(new URL('./audio.mjs', import.meta.url));
  const encoderPath = fileURLToPath(new URL('./lamejs-runtime.mjs', import.meta.url));
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'media-runtime-test', compatibilityDate: '2026-10-01',
    modules: [{ type: 'ESModule', path: entryPath, contents: `
      import { generateImage, generateSpeech, uploadMedia } from './media.mjs';
      export default { async fetch(request, bindings) {
        const env = { MEDIA_PROVIDER: '${provider === 'mixed' ? 'freeai' : provider}', ${provider === 'mixed' ? '' : `MEDIA_VOICE_PROVIDER: '${provider === 'laozhang' ? 'openrouter' : provider}',`} OPENROUTER_API_KEY: 'fake-key', TELEGRAM_BOT_TOKEN: 'fake-token',
          FREEAI_API_KEY: 'fake-free-key', LAOZHANG_API_KEY: 'fake-lao-key', LAOZHANG_IMAGE_MODEL: 'fixture-image-model',
          fetchImpl: (url, options) => bindings.UPSTREAM.fetch(url, options) };
        try {
          const image = await generateImage(env, 'snow');
          await uploadMedia(env, 42, 'image', image);
          const speech = await generateSpeech(env, 'سلام رفیق');
          await uploadMedia(env, 42, 'voice', speech);
          return Response.json({ ok: true, image: image.type, voice: speech.type });
        } catch (error) { return Response.json({ ok: false, code: error.code }); }
      } };
    ` }, { type: 'ESModule', path: helperPath, contents: await readFile(helperPath, 'utf8') },
    { type: 'ESModule', path: audioPath, contents: (await readFile(audioPath, 'utf8')).replace('@breezystack/lamejs', './lamejs-runtime.mjs') },
    { type: 'ESModule', path: encoderPath, contents: await readFile(new URL('../node_modules/@breezystack/lamejs/dist/lamejs.js', import.meta.url), 'utf8') }],
    serviceBindings: { UPSTREAM: 'fake-media-source' },
  }, {
    name: 'fake-media-source', compatibilityDate: '2026-10-01', modules: true,
    script: `export default { async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname === 'api.free.ai') {
        if (request.method === 'POST') {
          if (request.headers.get('Authorization') !== 'Bearer fake-free-key') return new Response('Bad auth', { status: 401 });
          const body = await request.json();
          if (url.pathname === '/v1/image/generate/' && body.model === 'sdxl') return Response.json({ image_url: '/static/outputs/image.png' });
          if (url.pathname === '/v1/tts/' && body.language === 'fa' && body.model === 'piper' && body.voice === 'fa_IR-amir-medium') return Response.json({ audio_url: '/static/outputs/voice.wav' });
        } else if (request.method === 'GET') {
          if (request.headers.has('Authorization')) return new Response('Credential leak', { status: 403 });
          if (url.pathname.endsWith('.png')) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), { headers: { 'Content-Type': 'image/png' } });
          if (url.pathname.endsWith('.wav')) return new Response(Uint8Array.from(atob('${Buffer.from(makeWav()).toString('base64')}'), ch => ch.charCodeAt(0)), { headers: { 'Content-Type': 'audio/wav' } });
        }
        return new Response('Unexpected Free.ai request', { status: 400 });
      }
      if (url.hostname === 'api2.laozhang.ai') {
        const body = await request.json();
        if (request.headers.get('Authorization') !== 'Bearer fake-lao-key' || url.pathname !== '/v1/images/generations' || body.model !== 'fixture-image-model' || body.n !== 1 || body.response_format !== 'b64_json') return new Response('Bad image request', { status: 400 });
        return Response.json({ data: [{ b64_json: 'iVBORw0KGgoA' }] });
      }
      if (url.hostname === 'openrouter.ai') {
        if (request.headers.get('Authorization') !== 'Bearer fake-key') return new Response('Bad auth', { status: 401 });
        const body = await request.json();
        if (url.pathname === '/api/v1/images' && body.n === 1) return Response.json({ data: [{ b64_json: 'iVBORw0KGgoA', media_type: 'image/png' }] });
        if (url.pathname === '/api/v1/audio/speech' && body.model === 'google/gemini-3.8-flash-lite-tts' && body.voice === 'Charon' && body.response_format === 'pcm') return new Response(Uint8Array.from(atob('${Buffer.from(makeWav({ sampleRate: 24000 }).subarray(44)).toString('base64')}'), ch => ch.charCodeAt(0)), { headers: { 'Content-Type': 'audio/pcm;rate=24000;channels=1' } });
      }
      if (url.hostname === 'api.telegram.org') {
        const form = await request.formData();
        const photo = url.pathname.endsWith('/sendPhoto');
        const file = form.get(photo ? 'photo' : 'voice');
        if (form.get('chat_id') !== '42' || !file || !form.get('caption') ||
          file.type !== (photo ? 'image/png' : 'audio/mpeg')) return Response.json({ ok: false });
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (photo ? bytes.length !== 9 : bytes.length < 100 || bytes[0] !== 255) return Response.json({ ok: false });
        return Response.json({ ok: true });
      }
      return new Response('Unexpected request', { status: 400 });
    } };`,
  }] }));
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch('https://runtime.test/media');
  assert.deepEqual(await response.json(), { ok: true, image: 'image/png', voice: 'audio/mpeg' });
});

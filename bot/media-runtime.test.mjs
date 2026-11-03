import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise actual Workers binary decoding + multipart upload, not Node-only mocks.
// Both upstream services are local fake bindings: no tokens or live paid calls.
for (const provider of ['openrouter', 'freeai']) test(`Workers ${provider} media runtime decodes files and uploads multipart attachments`, async t => {
  const helperPath = fileURLToPath(new URL('./media.mjs', import.meta.url));
  const entryPath = fileURLToPath(new URL('./media-runtime-entry.mjs', import.meta.url));
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'media-runtime-test', compatibilityDate: '2026-10-01',
    modules: [{ type: 'ESModule', path: entryPath, contents: `
      import { generateImage, generateSpeech, uploadMedia } from './media.mjs';
      export default { async fetch(request, bindings) {
        const env = { MEDIA_PROVIDER: '${provider}', OPENROUTER_API_KEY: 'fake-key', TELEGRAM_BOT_TOKEN: 'fake-token',
          FREEAI_API_KEY: 'fake-free-key', FREEAI_TTS_MODEL: 'test-persian-model', FREEAI_TTS_VOICE: 'test-persian-voice',
          fetchImpl: (url, options) => bindings.UPSTREAM.fetch(url, options) };
        try {
          const image = await generateImage(env, 'snow');
          await uploadMedia(env, 42, 'image', image);
          const speech = await generateSpeech(env, 'سلام رفیق');
          await uploadMedia(env, 42, 'voice', speech);
          return Response.json({ ok: true, image: image.type, voice: speech.type });
        } catch (error) { return Response.json({ ok: false, code: error.code }); }
      } };
    ` }, { type: 'ESModule', path: helperPath, contents: await readFile(helperPath, 'utf8') }],
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
          if (url.pathname === '/v1/tts/' && body.language === 'fa') return Response.json({ audio_url: '/static/outputs/voice.mp3' });
        } else if (request.method === 'GET') {
          if (request.headers.has('Authorization')) return new Response('Credential leak', { status: 403 });
          if (url.pathname.endsWith('.png')) return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), { headers: { 'Content-Type': 'image/png' } });
          if (url.pathname.endsWith('.mp3')) return new Response(new Uint8Array([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
        }
        return new Response('Unexpected Free.ai request', { status: 400 });
      }
      if (url.hostname === 'openrouter.ai') {
        if (request.headers.get('Authorization') !== 'Bearer fake-key') return new Response('Bad auth', { status: 401 });
        const body = await request.json();
        if (url.pathname === '/api/v1/images' && body.n === 1) return Response.json({ data: [{ b64_json: 'iVBORw0KGgoA', media_type: 'image/png' }] });
        if (url.pathname === '/api/v1/audio/speech' && body.response_format === 'mp3') return new Response(new Uint8Array([73, 68, 51, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
      }
      if (url.hostname === 'api.telegram.org') {
        const form = await request.formData();
        const photo = url.pathname.endsWith('/sendPhoto');
        const file = form.get(photo ? 'photo' : 'voice');
        if (form.get('chat_id') !== '42' || !file || !form.get('caption') ||
          file.type !== (photo ? 'image/png' : 'audio/mpeg') ||
          (await file.arrayBuffer()).byteLength !== (photo ? 9 : 4)) return Response.json({ ok: false });
        return Response.json({ ok: true });
      }
      return new Response('Unexpected request', { status: 400 });
    } };`,
  }] }));
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch('https://runtime.test/media');
  assert.deepEqual(await response.json(), { ok: true, image: 'image/png', voice: 'audio/mpeg' });
});

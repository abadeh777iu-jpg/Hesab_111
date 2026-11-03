import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise actual Workers binary decoding + multipart upload, not Node-only mocks.
// Both upstream services are local fake bindings: no tokens or live paid calls.
test('Workers media runtime decodes images, reads MP3 and uploads real multipart attachments', async t => {
  const helperPath = fileURLToPath(new URL('./media.mjs', import.meta.url));
  const entryPath = fileURLToPath(new URL('./media-runtime-entry.mjs', import.meta.url));
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'media-runtime-test', compatibilityDate: '2026-10-01',
    modules: [{ type: 'ESModule', path: entryPath, contents: `
      import { generateImage, generateSpeech, uploadMedia } from './media.mjs';
      export default { async fetch(request, bindings) {
        const env = { OPENROUTER_API_KEY: 'fake-key', TELEGRAM_BOT_TOKEN: 'fake-token',
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Node mocks accept redirect:'error'; Workers rejects it before network I/O.
// Exercise the actual shared helper inside workerd, using only a local service
// binding. No real upstream request, account credential or internet is needed.
test('Workers runtime fetch helper accepts JSON and rejects redirects without following them', async t => {
  const helperPath = fileURLToPath(new URL('./live-data.mjs', import.meta.url));
  const entryPath = fileURLToPath(new URL('./runtime-entry.mjs', import.meta.url));
  const source = await readFile(helperPath, 'utf8');
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'fetch-runtime-test', compatibilityDate: '2026-10-01',
    modules: [{ type: 'ESModule', path: entryPath, contents: `
      import { getJson } from './live-data.mjs';
      export default { async fetch(request, env) {
        const path = new URL(request.url).pathname;
        try {
          const data = await getJson('https://upstream.test' + path, (url, options) => env.UPSTREAM.fetch(url, options));
          return Response.json({ ok: true, data });
        } catch (error) {
          return Response.json({ ok: false, code: error.code });
        }
      } };
    ` }, { type: 'ESModule', path: helperPath, contents: source }],
    serviceBindings: { UPSTREAM: 'fake-weather-source' },
  }, {
    name: 'fake-weather-source', compatibilityDate: '2026-10-01', modules: true,
    script: `export default { async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/redirect') return new Response(null, { status: 302, headers: { Location: 'https://upstream.test/must-not-follow' } });
      if (path === '/must-not-follow') return Response.json({ followed: true });
      if (path === '/rate-limit') return new Response('private body must stay hidden', { status: 429 });
      return Response.json({ temperature: 13, city: 'Abadeh' });
    } };`,
  }] }));
  t.after(() => mf.dispose());
  const success = await mf.dispatchFetch('https://runtime.test/forecast');
  assert.deepEqual(await success.json(), { ok: true, data: { temperature: 13, city: 'Abadeh' } });
  const redirect = await mf.dispatchFetch('https://runtime.test/redirect');
  assert.deepEqual(await redirect.json(), { ok: false, code: 'HTTP_302' });
  const limited = await mf.dispatchFetch('https://runtime.test/rate-limit');
  assert.deepEqual(await limited.json(), { ok: false, code: 'HTTP_429' });
});

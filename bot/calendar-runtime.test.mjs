import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Real Workers Intl/JSON bundling, persistent DO routing and caching. No live requests.
test('calendar works in workerd via the existing MarketFeed binding with no extra migration or model', async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import { MarketFeed as ProductionFeed } from './worker.mjs';
    export class MarketFeed extends ProductionFeed { constructor(ctx, env) { super(ctx, { ...env, fetchImpl: (url, options) => env.UPSTREAM.fetch(url, options) }); } }
    import { iranToday } from './calendar.mjs';
    export default { async fetch(request, env) {
      const clock = iranToday(Date.parse('2026-11-04T12:00:00Z'));
      const leap = iranToday(Date.parse('2025-03-20T12:00:00Z'));
      const replies = await Promise.all([1, 2].map(() => env.MARKETS.get(env.MARKETS.idFromName('iran-calendar')).fetch('https://market.internal/calendar').then(r => r.text())));
      return Response.json({ clock, leap, replies });
    } };
  ` }, bundle: true, external: ['cloudflare:workers'], write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'calendar-runtime', modules: true, compatibilityDate: '2026-10-01', script: bundle.outputFiles[0].text,
    durableObjects: { MARKETS: 'MarketFeed' }, serviceBindings: { UPSTREAM: 'fake-calendar-source' },
  }, {
    name: 'fake-calendar-source', modules: true, compatibilityDate: '2026-10-01',
    script: `let calls = 0;
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (url.hostname !== 'calendar.google.com' || request.headers.has('Authorization') || request.method !== 'GET') throw new Error('Unexpected outbound request');
        if (++calls > 1) throw new Error('Cache not shared');
        const year = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', year: 'numeric' }).format(Date.now());
        let text = 'BEGIN:VCALENDAR\\r\\n';
        for (let month = 1; month <= 12; month++) text += 'BEGIN:VEVENT\\r\\nDTSTART;VALUE=DATE:' + year + String(month).padStart(2, '0') + '01\\r\\nSUMMARY:Test Holiday\\r\\nEND:VEVENT\\r\\n';
        return new Response(text + 'END:VCALENDAR\\r\\n', { headers: { 'Content-Type': 'text/calendar' } });
      } };`,
  }] }));
  t.after(() => mf.dispose());
  const result = await (await mf.dispatchFetch('https://calendar.test/date')).json();
  assert.equal(result.clock.sentence, 'امروز چهارشنبه‌ست، سیزدهم آبان ۱۴۰۵ 🌱');
  assert.deepEqual(result.leap.solar, { year: 1403, month: 12, day: 30 });
  assert.equal(result.replies[0], result.replies[1]);
  for (const text of result.replies) {
    assert.ok(text.includes('به وقت ایران'));
    assert.ok(text.includes('تعطیلات ایرانِ گوگل'));
    assert.ok(!text.includes('در دسترس نیست'));
  }
});

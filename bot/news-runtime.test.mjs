import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Bundle the actual XML parser and news code, then run them in real workerd.
// Every outbound URL is intercepted by a local fake: no paid or live requests.
test('Workers news runtime fetches fixed RSS, parses XML, rewrites once and uploads safe attributed Telegram text', async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import { NewsFeedHandler, newsReply } from './news.mjs';
    export default { async fetch(request, bindings) {
      const badModel = new URL(request.url).pathname === '/model-error';
      const state = new Map();
      const env = { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: badModel ? 'bad-model' : 'test-model',
        fetchImpl: (url, options) => bindings.UPSTREAM.fetch(url, options) };
      const feed = new NewsFeedHandler({ storage: { get: async key => state.get(key), put: async (key, value) => state.set(key, value) } }, env);
      const [response, concurrent] = await Promise.all([feed.fetch(), feed.fetch()]);
      const { items, ...metadata } = await response.json();
      if (!response.ok || !concurrent.ok || items.length !== 2) return Response.json({ ok: false });
      const html = await newsReply(env, items, metadata);
      const delivered = await bindings.UPSTREAM.fetch('https://api.telegram.org/botfake-token/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 42, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }) });
      return Response.json({ ok: (await delivered.json()).ok, html });
    } };
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'news-runtime-test', compatibilityDate: '2026-10-01', modules: true,
    script: bundle.outputFiles[0].text, serviceBindings: { UPSTREAM: 'fake-news-source' },
  }, {
    name: 'fake-news-source', compatibilityDate: '2026-10-01', modules: true,
    script: `let rssCalls = 0; let modelCalls = 0;
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (url.hostname === 'www.isna.ir' || url.hostname === 'feeds.bbci.co.uk') {
          rssCalls++;
          if (request.headers.has('Authorization') || request.method !== 'GET') return new Response('Bad request', { status: 400 });
          const isna = url.hostname === 'www.isna.ir';
          const link = isna ? 'https://www.isna.ir/news/123/test' : 'https://www.bbc.com/persian/articles/test';
          const title = isna ? 'خبر آزمایشی ایران از ایسنا' : 'خبر دوم ایران از بی بی سی';
          return new Response('<rss><channel><item><title><![CDATA[' + title + ']]></title><description>متن آزمایشی ایران</description><link>' + link + '</link><pubDate>' + new Date(Date.now() - 60000).toUTCString() + '</pubDate></item></channel></rss>', { headers: { 'Content-Type': 'application/rss+xml' } });
        }
        if (url.hostname === 'openrouter.ai') {
          modelCalls++;
          if (request.headers.get('Authorization') !== 'Bearer fake-key') return new Response('Auth', { status: 401 });
          const body = await request.json();
          if (body.model === 'bad-model') return new Response('private provider rejection', { status: 402 });
          if (body.max_tokens !== 320 || body.messages.length !== 2) return new Response('Bad body', { status: 400 });
          const items = JSON.parse(body.messages[1].content).untrusted_rss_reports;
          return Response.json({ choices: [{ message: { content: JSON.stringify(items.map(item => ({ id: item.id, text: item.source + ' یه خبر آزمایشی از ایران داره.' }))) } }] });
        }
        if (url.hostname === 'api.telegram.org') {
          const body = await request.json();
          const safe = body.parse_mode === 'HTML' && body.chat_id === 42 &&
            body.text.includes('href="https://www.isna.ir/news/123/test"') &&
            body.text.includes('href="https://www.bbc.com/persian/articles/test"') &&
            !body.text.includes('private provider rejection') && rssCalls === modelCalls * 2;
          return Response.json({ ok: safe });
        }
        return new Response('Unexpected URL', { status: 500 });
      } };`,
  }] }));
  t.after(() => mf.dispose());
  const success = await (await mf.dispatchFetch('https://runtime.test/news')).json();
  assert.equal(success.ok, true);
  assert.ok(success.html.includes('یه خبر آزمایشی'));
  const fallback = await (await mf.dispatchFetch('https://runtime.test/model-error')).json();
  assert.equal(fallback.ok, true);
  assert.ok(fallback.html.includes('تیترهای تازه'));
});

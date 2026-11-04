import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Bundle the actual XML parser and news code, then run them in real workerd.
// Every outbound URL is intercepted by a local fake: no paid or live requests.
test('Workers news runtime fetches fixed RSS, parses XML, rewrites once and uploads safe attributed Telegram text', async t => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import { NewsFeedHandler, newsReply, NEWS_SOURCES } from './news.mjs';
    export default { async fetch(request, bindings) {
      const path = new URL(request.url).pathname;
      const badModel = path === '/model-error';
      const only = path.startsWith('/only-') ? path.slice(6) : null;
      const state = new Map();
      const env = { OPENROUTER_API_KEY: 'fake-key', OPENROUTER_MODEL: badModel ? 'bad-model' : 'test-model',
        fetchImpl: (url, options) => only && NEWS_SOURCES.find(source => source.url === url)?.id !== only
          ? Promise.resolve(new Response('Simulated other source outage', { status: 503 })) : bindings.UPSTREAM.fetch(url, options) };
      const feed = new NewsFeedHandler({ storage: { get: async key => state.get(key), put: async (key, value) => state.set(key, value) } }, env);
      const [response, concurrent] = await Promise.all([feed.fetch(), feed.fetch()]);
      const { items, ...metadata } = await response.json();
      if (only) return Response.json({ ok: response.ok && concurrent.ok, items });
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
        if (['www.isna.ir', 'feeds.bbci.co.uk', 'www.irib-news.ir', 'moxie.foxnews.com', 't.me'].includes(url.hostname)) {
          rssCalls++;
          if (request.headers.has('Authorization') || request.method !== 'GET') return new Response('Bad request', { status: 400 });
          const stamp = new Date(Date.now() - 60000);
          if (url.hostname === 't.me') return new Response('<html><div class="tgme_widget_message" data-post="farsna/123"><div class="tgme_widget_message_text">خبر آزمایشی فارس از ایران<br/>متن آزمایشی درباره تهران</div><a class="tgme_widget_message_date" href="https://t.me/farsna/123"><time datetime="' + stamp.toISOString() + '">12:00</time></a></div></html>', { headers: { 'Content-Type': 'text/html' } });
          const links = { 'www.isna.ir': 'https://www.isna.ir/news/123/test', 'feeds.bbci.co.uk': 'https://www.bbc.com/persian/articles/test', 'www.irib-news.ir': 'https://www.irib-news.ir/fa/news/123/test', 'moxie.foxnews.com': 'https://www.foxnews.com/world/iran-test' };
          const title = url.hostname === 'moxie.foxnews.com' ? 'Iran test report' : 'خبر آزمایشی ایران از ' + url.hostname;
          return new Response('<rss><channel><item><title><![CDATA[' + title + ']]></title><description>متن آزمایشی ایران</description><link>' + links[url.hostname] + '</link><pubDate>' + stamp.toUTCString() + '</pubDate></item></channel></rss>', { headers: { 'Content-Type': 'application/rss+xml' } });
        }
        if (url.hostname === 'openrouter.ai') {
          modelCalls++;
          if (request.headers.get('Authorization') !== 'Bearer fake-key') return new Response('Auth', { status: 401 });
          const body = await request.json();
          if (body.model === 'bad-model') return new Response('private provider rejection', { status: 402 });
          if (body.max_tokens !== 320 || body.messages.length !== 2) return new Response('Bad body', { status: 400 });
          const items = JSON.parse(body.messages[1].content).untrusted_news_reports;
          return Response.json({ choices: [{ message: { content: JSON.stringify(items.map(item => ({ id: item.id, text: item.source + ' یه خبر آزمایشی از ایران داره.' }))) } }] });
        }
        if (url.hostname === 'api.telegram.org') {
          const body = await request.json();
          const safe = body.parse_mode === 'HTML' && body.chat_id === 42 &&
            (body.text.includes('https://www.isna.ir/news/123/test') || body.text.includes('https://www.irib-news.ir/fa/news/123/test') || body.text.includes('https://t.me/farsna/123')) &&
            (body.text.includes('https://www.bbc.com/persian/articles/test') || body.text.includes('https://www.foxnews.com/world/iran-test')) &&
            !body.text.includes('private provider rejection') && rssCalls === modelCalls * 5;
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
  for (const sourceId of ['fars', 'irib', 'fox']) {
    const isolated = await (await mf.dispatchFetch('https://runtime.test/only-' + sourceId)).json();
    assert.equal(isolated.ok, true, sourceId);
    assert.equal(isolated.items.length, 1, sourceId);
    assert.equal(isolated.items[0].sourceId, sourceId);
  }
});

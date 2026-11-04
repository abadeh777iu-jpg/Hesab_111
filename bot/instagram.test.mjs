import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInstagram, instagramRequest, safeInstagramVideo, parseInstagramPage, resolveInstagram, downloadInstagramVideo, parseRecognizedMusic, recognizeInstagramMusic, uploadInstagramVideo, musicReply, InstagramFeedHandler, MAX_IG_VIDEO, isMusicCallback, igDayEnd } from './instagram.mjs';

const original = 'https://www.instagram.com/reel/DfUr8XJoNJC/';
const video = 'https://instagram.ftia13-1.fna.fbcdn.net/o1/video.mp4?sig=test&oe=123';
const html = `<meta property="og:video" content="${video}.mp4"><video><source src="${video.replaceAll('&', '&amp;')}" type="video/mp4"></video>`;
const mp4 = () => new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const match = () => ({ code: 0, data: { matched: true, title: 'Test song', artist: 'Test artist', spotifyUrl: 'https://open.spotify.com/track/123?si=tracking', score: 95 } });
function memory() { const state = new Map(); return { state, storage: { get: async k => structuredClone(state.get(k)), put: async (k, v) => state.set(k, structuredClone(v)) } }; }

test('real example strips tracking and accepts only canonical public p/reel paths', () => {
  assert.equal(canonicalInstagram(original + '?exln=anZ2OTcyMmV3ZHU='), original);
  assert.deepEqual(instagramRequest(original + '?exln=anZ2OTcyMmV3ZHU='), { url: original });
  assert.equal(canonicalInstagram('https://instagram.com/reels/DfUr8XJoNJC/'), original);
  for (const url of ['http://instagram.com/p/abcde/', 'https://user:pass@instagram.com/p/abcde/', 'https://instagram.com:8000/p/abcde/', 'https://instagram.com/stories/user/123/', 'https://instagram.com/share/reel/123', 'https://instagram.com/../accounts/login', 'https://instagram.com.evil.test/p/abcde/', 'https://127.0.0.1/p/abcde/']) assert.equal(canonicalInstagram(url), null, url);
  assert.deepEqual(instagramRequest(original + ' ' + original), { url: null });
  assert.equal(instagramRequest('سلام خوبی؟'), null);
});

test('only Meta video CDN URLs pass; metadata prioritizes real video source over malformed signed OG URL', () => {
  assert.equal(parseInstagramPage(html), video);
  assert.equal(safeInstagramVideo(video), video);
  for (const url of ['https://evil.test/a.mp4', 'https://instagram.fbcdn.net.evil.test/a.mp4', 'http://instagram.a.fbcdn.net/a.mp4', 'https://user@instagram.a.fbcdn.net/a.mp4', 'https://instagram.a.fbcdn.net:8888/a.mp4', 'https://127.0.0.1/a.mp4', 'https://instagram.a.fbcdn.net/page.html']) assert.equal(safeInstagramVideo(url), null, url);
  assert.throws(() => parseInstagramPage('<html>Login required</html>'));
  assert.throws(() => parseInstagramPage('<video src="https://evil.test/private.mp4"></video>'));
  assert.throws(() => parseInstagramPage('x'.repeat(512 * 1024 + 1)));
  assert.throws(() => parseInstagramPage('<div>'.repeat(90) + html + '</div>'.repeat(90)));
});

test('resolver sends only clean public path to a fixed provider with no keys, cookies or private conversation', async () => {
  let calls = 0;
  const result = await resolveInstagram(async (url, options) => {
    calls++; assert.equal(url, 'https://www.vxinstagram.com/reel/DfUr8XJoNJC/');
    assert.equal(options.redirect, 'manual'); assert.deepEqual(options.headers, { Accept: 'text/html' });
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  }, original + '?exln=tracking');
  assert.equal(result, video); assert.equal(calls, 1);
});

test('redirects to private/other hosts, non-HTML and server errors stop instead of bypassing access checks', async () => {
  for (const response of [new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/private' } }), new Response('private body', { status: 403 }), new Response('{}', { headers: { 'Content-Type': 'application/json' } })]) {
    let calls = 0; await assert.rejects(resolveInstagram(async () => { calls++; return response; }, original)); assert.equal(calls, 1);
  }
});

test('video bytes are bounded and validated instead of forwarding untrusted remote URLs to Telegram', async () => {
  assert.deepEqual(await downloadInstagramVideo(async (url, options) => { assert.equal(url, video); assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, undefined); return new Response(mp4(), { headers: { 'Content-Type': 'video/mp4' } }); }, video), mp4());
  for (const response of [new Response('<html>error</html>', { headers: { 'Content-Type': 'video/mp4' } }), new Response(mp4(), { headers: { 'Content-Type': 'text/html' } }), new Response(mp4(), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(MAX_IG_VIDEO + 1) } }), new Response(null, { status: 302, headers: { Location: 'http://localhost/' } })]) await assert.rejects(downloadInstagramVideo(async () => response, video));
  await assert.rejects(downloadInstagramVideo(() => { throw new Error('Must not fetch'); }, 'https://evil.test/a.mp4'));
});

test('recognition uses documented no-key public-link API contract only after explicit request', async () => {
  const track = await recognizeInstagramMusic(async (url, options) => {
    assert.equal(url, 'https://songfinder.dev/api/music/recognize'); assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { Accept: 'application/json', 'X-SongFinder-Client': 'cli' });
    assert.deepEqual([...options.body.entries()], [['url', original], ['source', 'cli']]);
    return Response.json(match());
  }, original + '?tracking=remove');
  assert.deepEqual(track, { title: 'Test song', artist: 'Test artist', link: 'https://open.spotify.com/track/123', uncertain: false });
  assert.ok(musicReply(track).includes('فایل کامل با اجازهٔ دانلود در این نتیجه موجود نیست'));
});

test('recognition validates envelope and match; never guesses titles or forwards unauthorized audio/download links', () => {
  for (const payload of [{ code: 1, data: match().data }, { code: 0, data: { matched: false } }, { code: 0, data: { matched: true, title: 'Missing artist' } }]) assert.throws(() => parseRecognizedMusic(payload));
  const payload = match(); payload.data.spotifyUrl = 'https://evil.test/music.mp3'; payload.data.songLink = 'https://www.shazam.com/track/123/test?tracking=yes'; payload.data.score = 30;
  const track = parseRecognizedMusic(payload); assert.equal(track.link, 'https://www.shazam.com/track/123/test'); assert.equal(track.uncertain, true);
  assert.ok(!musicReply(track).includes('evil.test'));
});

test('music 403/429, redirects, oversized JSON and non-JSON fail safely without alternate paid endpoints', async () => {
  for (const response of [new Response('secret quota', { status: 429 }), new Response('secret body', { status: 403 }), new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } }), new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } })]) {
    let calls = 0; await assert.rejects(recognizeInstagramMusic(async () => { calls++; return response; }, original)); assert.equal(calls, 1);
  }
});

test('Telegram video is uploaded as a file with an opaque inline callback, not a private-media URL or bot token', async () => {
  const token = 'a'.repeat(32);
  const messageId = await uploadInstagramVideo({ TELEGRAM_BOT_TOKEN: 'fake-token', fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/sendVideo')); assert.ok(options.body.get('video') instanceof Blob);
    assert.deepEqual(JSON.parse(options.body.get('reply_markup')), { inline_keyboard: [[{ text: '🎵 شناسایی موسیقی', callback_data: 'igmusic:' + token }]] });
    assert.ok(!options.body.get('caption').includes('fake-token'));
    return Response.json({ ok: true, result: { message_id: 123, video: { file_id: 'fake-video-id' } } });
  } }, 42, mp4(), token, original);
  assert.equal(messageId, 123); assert.equal(isMusicCallback('igmusic:' + token), true); assert.equal(isMusicCallback('igmusic:https://evil.test'), false);
});

test('shared cache serializes requests and keeps independent source budgets with no private user IDs', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-04T12:00:00Z'));
  const { storage, state } = memory(); let calls = 0;
  const handler = new InstagramFeedHandler({ storage }, { fetchImpl: async url => {
    calls++; return url.includes('songfinder') ? Response.json(match()) : new Response(html, { headers: { 'Content-Type': 'text/html' } });
  } });
  const request = kind => new Request('https://internal/ig-' + kind, { method: 'POST', body: JSON.stringify({ url: original }) });
  const responses = await Promise.all([handler.fetch(request('resolve')), handler.fetch(request('resolve'))]);
  for (const response of responses) assert.equal((await response.json()).value, video);
  assert.equal(calls, 1); assert.equal((await (await handler.fetch(request('recognize'))).json()).value.title, 'Test song');
  assert.equal(calls, 2); assert.equal(state.get('igBudget').video, 1); assert.equal(state.get('igBudget').music, 1);
  assert.ok(!JSON.stringify([...state.values()]).includes('user_id'));
});

test('failed calls count against persistent limits; global cooldown and UTC reset do not change other budgets', async t => {
  let now = Date.parse('2026-11-04T12:00:00Z'); t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory(); state.set('priceAttempts', 3);
  let calls = 0; const handler = new InstagramFeedHandler({ storage }, { fetchImpl: async () => { calls++; throw new Error('secret-key'); } });
  const request = () => new Request('https://internal/ig-resolve', { method: 'POST', body: JSON.stringify({ url: original }) });
  await handler.fetch(request()); assert.equal((await (await handler.fetch(request())).json()).code, 'RATE'); assert.equal(calls, 1);
  for (let i = 1; i < 10; i++) { now += 60000; await handler.fetch(request()); }
  now += 60000; assert.equal((await (await handler.fetch(request())).json()).code, 'LIMIT'); assert.equal(calls, 10);
  now = igDayEnd(now); await handler.fetch(request()); assert.equal(calls, 11); assert.equal(state.get('priceAttempts'), 3);
});

test('Telegram video file_id reuse never passes a remote URL or redownloads video bytes', async () => {
  let calls = 0;
  const env = { TELEGRAM_BOT_TOKEN: 'fake', fetchImpl: async (url, options) => {
    calls++; assert.ok(url.endsWith('/sendVideo'));
    assert.equal(options.body.get('video'), 'previously-uploaded-id');
    return Response.json({ ok: true, result: { message_id: 456, video: { file_id: 'previously-uploaded-id' } } });
  } };
  const result = await uploadInstagramVideo(env, 43, 'previously-uploaded-id', 'a'.repeat(32), original, true);
  assert.deepEqual(result, { messageId: 456, fileId: 'previously-uploaded-id' });
  await assert.rejects(uploadInstagramVideo(env, 43, 'https://evil.test/private.mp4', 'a'.repeat(32), original));
  assert.equal(calls, 1);
});

test('shared Telegram file metadata is capped at ten, expires after five minutes and does not consume provider budgets', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { storage, state } = memory();
  const handler = new InstagramFeedHandler({ storage }, { fetchImpl: () => { throw new Error('No source call allowed'); } });
  const call = async (path, url, fileId) => (await handler.fetch(new Request('https://internal/ig-file-' + path, { method: 'POST', body: JSON.stringify({ url, fileId }) }))).json();
  for (let i = 0; i < 20; i++) await call('put', 'https://www.instagram.com/reel/ABCDE' + i + '/', 'file-for-video-' + i);
  assert.equal(state.get('igTelegramFiles').length, 10); assert.equal(state.has('igBudget'), false);
  const url = 'https://www.instagram.com/reel/ABCDE19/';
  assert.equal((await call('get', url)).value, 'file-for-video-19');
  await call('put', url, null); assert.equal((await call('get', url)).value, null);
  await call('put', url, 'file-for-video-19'); now += 5 * 60000;
  assert.equal((await call('get', url)).value, null);
  assert.equal((await call('put', url, 'https://evil.test/video.mp4')).ok, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { answerToTelegramVoice, GeminiAudioError } from './gemini-audio.mjs';

test('voice message is fetched from Telegram, sent to Gemini, and converted into a Persian answer', async () => {
  const calls = [];
  const env = { TELEGRAM_BOT_TOKEN: 'fake-token', GEMINI_API_KEY: 'fake-key', fetchImpl: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('getFile?')) return Response.json({ ok: true, result: { file_path: 'voice/file.ogg' } });
    if (String(url).includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/ogg' } });
    return Response.json({ candidates: [{ content: { parts: [{ text: 'سلام، خوبی؟' }] } }] });
  } };
  const answer = await answerToTelegramVoice(env, { voice: { file_id: 'f1', file_size: 3, mime_type: 'audio/ogg' } });
  assert.equal(answer, 'سلام، خوبی؟');
  assert.equal(calls.length, 3);
  const req = JSON.parse(calls[2].init.body);
  assert.equal(req.contents[0].parts[1].inline_data.mime_type, 'audio/ogg');
  assert.equal(req.contents[0].parts[1].inline_data.data, 'AQID');
  assert.match(calls[2].url, /models\/gemini-2\.5-flash:generateContent/);
});

test('voice input rejects oversized Telegram files before any download', async () => {
  let calls = 0;
  await assert.rejects(() => answerToTelegramVoice({ TELEGRAM_BOT_TOKEN: 't', GEMINI_API_KEY: 'k', fetchImpl: async () => { calls++; } }, { voice: { file_id: 'f', file_size: 6 * 1024 * 1024, mime_type: 'audio/ogg' } }), error => error instanceof GeminiAudioError && error.code === 'AUDIO_SIZE');
  assert.equal(calls, 0);
});

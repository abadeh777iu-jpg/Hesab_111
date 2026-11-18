// Telegram voice-note understanding and voice generation via Gemini generateContent.
// This is request/response, not the persistent Gemini Live WebSocket.
import { pcm16ToMp3 } from './audio.mjs';
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MIME_TYPES = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/aac', 'audio/flac']);
export class GeminiAudioError extends Error {
  constructor(code) { super('Gemini audio request failed'); this.code = code; }
}
async function readLimited(response, limit) {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > limit || !response.body) throw new GeminiAudioError('AUDIO_SIZE');
  const reader = response.body.getReader(), parts = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > limit) { await reader.cancel(); throw new GeminiAudioError('AUDIO_SIZE'); }
    parts.push(value);
  }
  if (!size) throw new GeminiAudioError('AUDIO_EMPTY');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
const base64 = bytes => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
export async function answerToTelegramVoice(env, message) {
  const token = env.TELEGRAM_BOT_TOKEN, key = env.GEMINI_API_KEY;
  const model = (env.GEMINI_AUDIO_MODEL || 'gemini-2.5-flash').trim();
  if (!token || !key) throw new GeminiAudioError('AUDIO_CONFIG');
  const audio = message.voice || message.audio;
  if (!audio?.file_id || !Number.isFinite(audio.file_size) || audio.file_size > MAX_AUDIO_BYTES) throw new GeminiAudioError('AUDIO_SIZE');
  const telegramFetch = env.fetchImpl || fetch;
  const metaRes = await telegramFetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(audio.file_id)}`, { signal: AbortSignal.timeout(10_000) });
  if (!metaRes.ok) throw new GeminiAudioError('AUDIO_TELEGRAM');
  const meta = await metaRes.json();
  const path = meta?.result?.file_path;
  if (!meta?.ok || typeof path !== 'string' || path.startsWith('/') || path.includes('..')) throw new GeminiAudioError('AUDIO_TELEGRAM');
  const fileRes = await telegramFetch(`https://api.telegram.org/file/bot${token}/${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!fileRes.ok) throw new GeminiAudioError('AUDIO_TELEGRAM');
  const bytes = await readLimited(fileRes, MAX_AUDIO_BYTES);
  const mime = (audio.mime_type || 'audio/ogg').split(';')[0].toLowerCase();
  if (!MIME_TYPES.has(mime)) throw new GeminiAudioError('AUDIO_FORMAT');
  const response = await telegramFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [
      { text: 'به فارسی و کوتاه به حرفی که در این ویس گفته شده پاسخ بده. اگر سؤال نیست، منظور گوینده را کوتاه بازگو کن. فقط پاسخ را بنویس.' },
      { inline_data: { mime_type: mime, data: base64(bytes) } },
    ] }], generationConfig: { maxOutputTokens: 320 } }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new GeminiAudioError(response.status === 429 ? 'AUDIO_BUSY' : response.status === 401 || response.status === 403 ? 'AUDIO_CONFIG' : 'AUDIO_MODEL');
  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!text) throw new GeminiAudioError('AUDIO_EMPTY');
  return text.slice(0, 1800);
}

export async function synthesizeGeminiVoice(env, text) {
  const key = env.GEMINI_API_KEY;
  const model = (env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts').trim();
  if (!key) throw new GeminiAudioError('AUDIO_CONFIG');
  const response = await (env.fetchImpl || fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: `به فارسی طبیعی و روشن، این متن را عیناً بخوان. چیزی اضافه نکن: ${text.slice(0, 600)}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_TTS_VOICE || 'Charon' } } } } }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new GeminiAudioError(response.status === 429 ? 'AUDIO_BUSY' : response.status === 401 || response.status === 403 ? 'AUDIO_CONFIG' : 'AUDIO_MODEL');
  const result = await response.json();
  const part = result?.candidates?.[0]?.content?.parts?.find(item => item.inlineData?.data || item.inline_data?.data);
  const payload = part?.inlineData || part?.inline_data;
  if (typeof payload?.data !== 'string' || !/^audio\/pcm(?:;|$)/i.test(payload.mimeType || payload.mime_type || '')) throw new GeminiAudioError('AUDIO_EMPTY');
  let raw;
  try { raw = atob(payload.data); } catch { throw new GeminiAudioError('AUDIO_EMPTY'); }
  if (!raw.length || raw.length > MAX_AUDIO_BYTES || raw.length % 2) throw new GeminiAudioError('AUDIO_SIZE');
  const pcm = Uint8Array.from(raw, char => char.charCodeAt(0));
  try { return { bytes: pcm16ToMp3(pcm, 24000), type: 'audio/mpeg', filename: 'gemini-voice.mp3' }; }
  catch { throw new GeminiAudioError('AUDIO_FORMAT'); }
}

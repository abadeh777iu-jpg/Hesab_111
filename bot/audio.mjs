import { Mp3Encoder } from '@breezystack/lamejs';

// Free.ai/Piper may return WAV even when MP3 was requested. Convert locally:
// no second paid API call, subprocess, filesystem, voice cloning or external host.
export function wavToMp3(bytes) {
  const invalid = () => { throw new Error('Unsupported WAV'); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 44 || bytes.length > 5 * 1024 * 1024) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) invalid();
  let format, data;
  for (let at = 12; at < bytes.length;) {
    if (at + 8 > bytes.length) invalid();
    const size = view.getUint32(at + 4, true);
    const begin = at + 8;
    const end = begin + size;
    if (end + (size % 2) > bytes.length) invalid();
    if (tag(at) === 'fmt ') {
      if (format || size < 16) invalid();
      format = {
        encoding: view.getUint16(begin, true), channels: view.getUint16(begin + 2, true),
        sampleRate: view.getUint32(begin + 4, true), byteRate: view.getUint32(begin + 8, true),
        blockAlign: view.getUint16(begin + 12, true), bits: view.getUint16(begin + 14, true),
      };
    } else if (tag(at) === 'data') {
      if (data || !size) invalid();
      data = { begin, size };
    }
    at = end + (size % 2);
  }
  if (!format || !data) invalid();
  const { encoding, channels, sampleRate, byteRate, blockAlign, bits } = format;
  if (![1, 2].includes(channels) || ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate) ||
      !((encoding === 1 && bits === 16) || (encoding === 3 && bits === 32)) ||
      blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign || data.size % blockAlign) invalid();
  const frames = data.size / blockAlign;
  if (frames / sampleRate > 90) invalid();
  const encoder = new Mp3Encoder(channels, sampleRate, channels === 1 ? 64 : 96);
  const chunks = [];
  let size = 0;
  const append = chunk => {
    if (!chunk.length) return;
    size += chunk.length;
    if (size > 2 * 1024 * 1024) invalid();
    chunks.push(Uint8Array.from(chunk));
  };
  // Read little-endian samples explicitly; don't assume buffer alignment/endian.
  const sample = (frame, channel) => {
    const at = data.begin + frame * blockAlign + channel * bits / 8;
    if (encoding === 1) return view.getInt16(at, true);
    const value = view.getFloat32(at, true);
    if (!Number.isFinite(value)) invalid();
    return Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
  };
  for (let begin = 0; begin < frames; begin += 1152) {
    const length = Math.min(1152, frames - begin);
    const left = new Int16Array(length);
    const right = channels === 2 ? new Int16Array(length) : null;
    for (let i = 0; i < length; i++) {
      left[i] = sample(begin + i, 0);
      if (right) right[i] = sample(begin + i, 1);
    }
    append(right ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left));
  }
  append(encoder.flush());
  if (!size) invalid();
  const result = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}

// OpenRouter's Gemini speech endpoint returns signed 16-bit little-endian PCM,
// 24 kHz mono. Give it a genuine WAV header before using the bounded encoder.
export function pcm16ToMp3(bytes, sampleRate = 24000) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % 2 || bytes.length > 5 * 1024 * 1024 - 44 ||
      ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate) || bytes.length / (2 * sampleRate) > 90) throw new Error('Unsupported PCM');
  const wav = new Uint8Array(44 + bytes.length);
  const view = new DataView(wav.buffer);
  const tag = (at, value) => wav.set(new TextEncoder().encode(value), at);
  tag(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data');
  view.setUint32(40, bytes.length, true); wav.set(bytes, 44);
  return wavToMp3(wav);
}

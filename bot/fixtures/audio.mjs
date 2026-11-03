// Synthetic sine-wave fixtures only; no real speech or personal recordings.
export function makeWav({ channels = 1, sampleRate = 22050, seconds = 0.12, float = false } = {}) {
  const frames = Math.floor(sampleRate * seconds);
  const sampleBytes = float ? 4 : 2;
  const bytes = new Uint8Array(44 + frames * channels * sampleBytes);
  const view = new DataView(bytes.buffer);
  const tag = (at, text) => bytes.set(new TextEncoder().encode(text), at);
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * sampleBytes, true);
  view.setUint16(32, channels * sampleBytes, true); view.setUint16(34, sampleBytes * 8, true);
  tag(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  for (let frame = 0; frame < frames; frame++) for (let ch = 0; ch < channels; ch++) {
    const value = Math.sin(frame * 2 * Math.PI * (ch ? 550 : 440) / sampleRate) * 0.3;
    const at = 44 + (frame * channels + ch) * sampleBytes;
    if (float) view.setFloat32(at, value, true);
    else view.setInt16(at, Math.round(value * 32767), true);
  }
  return bytes;
}


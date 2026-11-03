import test from 'node:test';
import assert from 'node:assert/strict';
import { wavToMp3 } from './audio.mjs';

import { makeWav } from './fixtures/audio.mjs';

// Parse all MPEG frames, not just the first magic bytes. This also ensures the
// output isn't a WAV payload merely relabeled .mp3.
function countMp3Frames(bytes) {
  let at = 0, frames = 0;
  const rates = [44100, 48000, 32000];
  while (at < bytes.length) {
    assert.equal(bytes[at], 255);
    assert.equal(bytes[at + 1] & 224, 224);
    const version = (bytes[at + 1] >> 3) & 3;
    assert.ok([0, 2, 3].includes(version));
    assert.equal((bytes[at + 1] >> 1) & 3, 1); // Layer III
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[(bytes[at + 2] >> 4) & 15];
    const rate = rates[(bytes[at + 2] >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    assert.ok(bitrate && rate);
    const size = Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / rate) + ((bytes[at + 2] >> 1) & 1);
    assert.ok(at + size <= bytes.length);
    at += size; frames++;
  }
  return frames;
}

test('local WAV conversion produces complete MP3 frames from mono/stereo PCM and float audio', () => {
  for (const options of [{}, { channels: 2, sampleRate: 44100 }, { float: true, sampleRate: 24000 }, { sampleRate: 8000 }]) {
    const mp3 = wavToMp3(makeWav(options));
    assert.ok(countMp3Frames(mp3) >= 2);
    assert.ok(mp3.length < 20_000);
  }
});

test('malformed WAV, unsupported formats and excessive durations fail before unsafe encoding', () => {
  const cases = [new Uint8Array(0), new TextEncoder().encode('RIFF not audio')];
  for (const mutate of [
    view => view.setUint32(4, 0xffffffff, true),
    view => view.setUint32(40, 0xffffffff, true),
    view => view.setUint16(22, 9, true),
    view => view.setUint32(24, 999999999, true),
    view => view.setUint16(20, 7, true),
    view => view.setUint16(34, 8, true),
    view => view.setUint16(32, 6, true),
    view => view.setUint32(28, 1, true),
  ]) {
    const bytes = makeWav(); mutate(new DataView(bytes.buffer)); cases.push(bytes);
  }
  const nan = makeWav({ float: true }); new DataView(nan.buffer).setFloat32(44, NaN, true); cases.push(nan);
  cases.push(makeWav({ sampleRate: 8000, seconds: 91 }));
  for (const bytes of cases) assert.throws(() => wavToMp3(bytes), /Unsupported WAV/);
});

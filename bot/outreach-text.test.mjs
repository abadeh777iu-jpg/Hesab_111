import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWeatherSentence } from './outreach-text.mjs';

const event = { kind: 'rain', severe: false, at: Date.now() + 3600000 };
const output = content => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

test('each recipient/event gets a fresh generation with a random variation, not shared text', async () => {
  const calls = [];
  const env = { OPENROUTER_API_KEY: 'secret-key', OPENROUTER_MODEL: 'chosen/model', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    calls.push(JSON.parse(options.body));
    return output(calls.length === 1 ? 'گاهی یه نفس آروم، شروع یه حال تازه‌ست 🌱' : 'برای قدم کوچیک بعدیت هم جا هست، عجله نکن ✨');
  } };
  const first = await generateWeatherSentence(env, event);
  const second = await generateWeatherSentence(env, event);
  assert.notEqual(first, second);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'chosen/model');
  assert.equal(calls[0].max_tokens, 120);
  assert.equal(calls[0].temperature, 0.95);
  const prompts = calls.map(call => JSON.parse(call.messages[1].content));
  assert.notEqual(prompts[0].variation, prompts[1].variation);
  assert.equal(prompts[0].weather, 'rain');
});

test('only a coarse local tone is shared; raw private messages, IDs and expired context are not', async () => {
  const prompts = [];
  const env = { OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async (_, options) => {
    prompts.push(JSON.parse(options.body));
    return output('امروز هم می‌تونی به اندازهٔ توانت با خودت مهربون باشی 🌱');
  } };
  const privateText = 'نگرانم، من نام خصوصی دارم و شماره‌ام 123456789 است';
  await generateWeatherSentence(env, event, { expiresAt: Date.now() + 60000, messages: [{ role: 'user', content: privateText }] });
  await generateWeatherSentence(env, event, { expiresAt: Date.now() - 1, messages: [{ role: 'user', content: privateText }] });
  assert.equal(JSON.parse(prompts[0].messages[1].content).tone, 'gentle');
  assert.equal(JSON.parse(prompts[1].messages[1].content).tone, 'warm');
  assert.ok(!JSON.stringify(prompts).includes(privateText));
  assert.ok(!JSON.stringify(prompts).includes('123456789'));
});

test('severe-weather prompts carry caution and never ask to enjoy dangerous weather outside', async () => {
  const env = { OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model', fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(JSON.parse(body.messages[1].content).severe, true);
    assert.ok(body.messages[0].content.includes('بیرون‌رفتن دعوت نکن'));
    return output('گاهی قشنگ‌ترین انتخاب، مراقبت آرام از خودته 🌱');
  } };
  assert.ok(await generateWeatherSentence(env, { kind: 'snow', severe: true }));
});

test('missing config, upstream errors, empty/verbose/unsafe output gracefully omit the sentence', async () => {
  let calls = 0;
  assert.equal(await generateWeatherSentence({ fetchImpl: async () => { calls++; } }, event), null);
  assert.equal(calls, 0);
  const base = { OPENROUTER_API_KEY: 'key', OPENROUTER_MODEL: 'model' };
  for (const fetchImpl of [
    async () => { throw new Error('private URL/key'); },
    async () => new Response('private body', { status: 429 }),
    async () => output(''), async () => output('سلام\nرفیق'),
    async () => output('x'.repeat(241)), async () => output('برو https://example.com'),
    async () => output('شماره شما 123456789 است'), async () => output('<b>پیام</b>'),
  ]) assert.equal(await generateWeatherSentence({ ...base, fetchImpl }, event), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReply } from './format.mjs';

test('plain responses and model-provided HTML are safely escaped', () => {
  assert.deepEqual(formatReply('سلام 🙂 <b>hi</b> & "text"'), [
    { text: 'سلام 🙂 &lt;b&gt;hi&lt;/b&gt; &amp; "text"', parse_mode: 'HTML' },
  ]);
});

test('opinions become native blockquotes, never untrusted HTML', () => {
  const result = formatReply('باشه 🌱 [OPINION]به نظرم <a href="x">شروع کن</a> 💪[/OPINION] تو چی فکر می‌کنی؟');
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'باشه 🌱\n\n<blockquote>💬 نظر امیر\nبه نظرم &lt;a href="x"&gt;شروع کن&lt;/a&gt; 💪</blockquote>\n\nتو چی فکر می‌کنی؟');
});

test('empty, malformed and truncated markers do not break Telegram parsing', () => {
  assert.deepEqual(formatReply(''), []);
  assert.deepEqual(formatReply('[OPINION] [/OPINION]'), []);
  assert.equal(formatReply('[OPINION]نظر ناقص')[0].text, 'نظر ناقص');
  assert.equal(formatReply('test [/OPINION]')[0].text, 'test');
});

test('long opinions preserve content, close tags per message and preserve emoji', () => {
  const original = 'شروع کن 🌱💪 '.repeat(800);
  const messages = formatReply(`[OPINION]${original}[/OPINION]`);
  assert.ok(messages.length > 1);
  const joined = messages.map(({ text }) => {
    assert.ok(text.startsWith('<blockquote>'));
    assert.ok(text.endsWith('</blockquote>'));
    const plain = text.slice('<blockquote>'.length, -'</blockquote>'.length);
    assert.ok(plain.length <= 3500);
    assert.ok(!/[\uD800-\uDBFF]$/.test(plain));
    return plain;
  }).join('');
  assert.equal(joined, `💬 نظر امیر\n${original.trim()}`);
});

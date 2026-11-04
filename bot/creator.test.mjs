import test from 'node:test';
import assert from 'node:assert/strict';
import { CREATOR_CONTACT, CREATOR_REPLY, isCreatorQuestion } from './creator.mjs';
import { systemPrompt } from './core.mjs';

test('creator questions and explicit command resolve to the public contact supplied by the owner', () => {
  assert.equal(CREATOR_CONTACT, '@LC_amir1');
  assert.ok(CREATOR_REPLY.includes(CREATOR_CONTACT));
  for (const text of ['/creator', '/creator@my_bot', 'سازنده کیه؟', 'سازنده‌ات کیه؟', 'سازندت کیه', 'کی سازندته؟', 'کی ساختت؟', 'کی تورو ساخته؟', 'تو رو کی ساخته؟', 'این ربات رو چه کسی ساخته؟', 'مدیر ربات کیه؟', 'آیدی سازنده رو بده', 'راه ارتباط با سازنده چیه؟', 'چطور با سازنده تماس بگیرم؟', 'سلام امیر، سازنده این ربات کیه؟']) assert.equal(isCreatorQuestion(text), true, text);
});

test('creator shortcut does not hijack personal, crisis, model-provider or unrelated manufacturer questions', () => {
  for (const text of [undefined, '', 'سلام', 'اسمت چیه؟', 'سازنده گوشی من کیه؟', 'سازنده مدل هوش مصنوعی کیه؟', 'سازنده کیه؟ می‌خوام به خودم آسیب بزنم', '/voice سازنده کیه', 'سازنده بمب کیه', 'دوست دارم یه سازنده نرم‌افزار بشم', 'سازنده '.repeat(100)]) assert.equal(isCreatorQuestion(text), false, text);
});

test('model guidance distinguishes the bot contact from model developer and never promises human monitoring', () => {
  const prompt = systemPrompt();
  assert.ok(prompt.includes(CREATOR_CONTACT));
  assert.ok(prompt.includes('نه سازندهٔ مدل هوش مصنوعی'));
  assert.ok(prompt.includes('مشاهدهٔ پیام‌ها توسط او را تضمین نکن'));
  assert.ok(CREATOR_REPLY.includes('پاسخ‌هام پیام زندهٔ سازنده نیست'));
});

// Public contact supplied by the bot owner; never a model/provider identity.
export const CREATOR_CONTACT = '@LC_amir1';
export const CREATOR_REPLY = `سازندهٔ این ربات: ${CREATOR_CONTACT} 🌱\nمن همراه هوش مصنوعی‌ام؛ پاسخ‌هام پیام زندهٔ سازنده نیست.`;

export function isCreatorQuestion(text) {
  if (typeof text !== 'string' || text.length > 500) return false;
  const clean = text.normalize('NFKC').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\u200c/g, ' ')
    .replace(/[؟?!،,.;؛:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^\/creator(?:@[a-z0-9_]+)?$/i.test(clean)) return true;
  const question = clean.replace(/^(?:(?:سلام|امیر|رفیق|راستی|لطفا|لطفاً)\s+){0,3}/u, '');
  const owner = '(?:سازنده(?: ات| ت| ی تو| تو| ربات| این ربات)?|سازندت|مدیر(?:ت| ربات| این ربات)|صاحب(?:ت| ربات| این ربات))';
  const who = '(?:کیه|کیست|کی هست|چه کسیه|چه کسی است)';
  return new RegExp(`^(?:${owner} ${who}|کی ${owner}(?: هست|ه)?|(?:تو رو|تورو|تو را|این ربات رو|این ربات را) (?:کی|چه کسی) (?:ساخته|ساخته است|ساخت)|(?:کی|چه کسی) (?:تو رو |تورو |تو را |این ربات رو |این ربات را )?(?:ساختت|ساخته|ساخته است)|(?:آیدی|ایدی|لینک|راه ارتباط با) ${owner}(?: چیه| چیست| رو بده| رو بگو| را بده)?|(?:چطور|چجوری) با ${owner} (?:ارتباط بگیرم|تماس بگیرم)|درباره ${owner}(?: بگو| توضیح بده))$`, 'u').test(question);
}

import { CHANNEL_UPDATES } from './channel-library.mjs';
import { WEBHOOK_CONNECTIONS } from './load-control.mjs';
export const REQUIRED_CHANNEL = '@qhatel_roya';
export const CHANNEL_URL = 'https://t.me/qhatel_roya';
export const JOIN_CALLBACK = 'membership:check:v1';
export const JOIN_KEYBOARD = { inline_keyboard: [
  [{ text: '📢 عضویت در کانال', url: CHANNEL_URL }],
  [{ text: '✅ عضو شدم — بررسی عضویت', callback_data: JOIN_CALLBACK }],
] };
export const JOIN_TEXT = 'برای چت با من اول عضو کانال شو 🌱\nبعد روی «✅ عضو شدم» بزن تا عضویتت رو بررسی کنم.\nاگر دکمه جواب نداد، بعد از عضویت /start رو بفرست.';
export const JOIN_UNAVAILABLE = 'الان نتونستم عضویتت رو بررسی کنم؛ فعلاً چت باز نمی‌شه. کمی بعد دوباره «✅ عضو شدم» رو بزن 🌱\nاگر ادامه داشت، به سازنده خبر بده: @LC_amir1';

// Explicit maintenance switch; enabled by default, including for the owner.
export const membershipRequired = env => env.JOIN_REQUIRED !== 'false';
const isAdmin = status => status === 'administrator' || status === 'creator';

export class MembershipGate {
  constructor(telegram) { this.telegram = telegram; this.botId = null; }
  async check(userId) {
    try {
      if (!Number.isSafeInteger(userId) || userId <= 0) return 'unavailable';
      if (!this.botId) {
        const bot = await this.telegram('getMe', {});
        if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || bot.is_bot !== true) return 'unavailable';
        this.botId = bot.id;
      }
      // Telegram only guarantees other users' membership lookups for admins.
      // Recheck bot rights, and user membership, on every protected interaction.
      const admin = await this.telegram('getChatMember', { chat_id: REQUIRED_CHANNEL, user_id: this.botId });
      if (admin?.user?.id !== this.botId || !isAdmin(admin.status)) return 'unavailable';
      const member = await this.telegram('getChatMember', { chat_id: REQUIRED_CHANNEL, user_id: userId });
      if (member?.user?.id !== userId) return 'unavailable';
      if (isAdmin(member.status) || member.status === 'member' || (member.status === 'restricted' && member.is_member === true)) return 'member';
      if (['left', 'kicked', 'restricted'].includes(member.status)) return 'nonmember';
      return 'unavailable';
    } catch { return 'unavailable'; } // No provider bodies, IDs or token URLs in logs.
  }
}

// Existing installations may omit callbacks or channel posts. Upgrade the same verified
// webhook, preserving its secret and pending updates, with bounded parallel delivery. Never
// change an unrelated webhook or trust a URL contained in a user message.
export async function enableMembershipCallbacks(telegram, expectedURL, secret) {
  if (!expectedURL || !secret) return false;
  let target;
  try { target = new URL(expectedURL); } catch { return false; }
  if (target.protocol !== 'https:' || target.pathname !== '/webhook' || target.username || target.password || target.search || target.hash) return false;
  const info = await telegram('getWebhookInfo', {});
  if (info?.url !== target.href) return false;
  const updatesAllowed = !info.allowed_updates?.length || CHANNEL_UPDATES.every(type => info.allowed_updates.includes(type));
  if (updatesAllowed && info.max_connections >= WEBHOOK_CONNECTIONS) return true;
  await telegram('setWebhook', { url: info.url, secret_token: secret,
    allowed_updates: !info.allowed_updates?.length ? [] : [...new Set([...info.allowed_updates, ...CHANNEL_UPDATES])],
    max_connections: Math.max(info.max_connections || 1, WEBHOOK_CONNECTIONS), drop_pending_updates: false });
  return true;
}

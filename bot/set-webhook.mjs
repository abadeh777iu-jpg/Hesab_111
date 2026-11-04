import { WEBHOOK_CONNECTIONS } from './load-control.mjs';
// Run locally with --env-file=.env.bot. Never put tokens in command arguments.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
let base;
try { base = new URL(process.argv[2]); } catch { /* validated below */ }
if (!token || !secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret) ||
    !base || base.protocol !== 'https:' || !base.hostname.endsWith('.workers.dev') ||
    base.username || base.password || base.port || base.search || base.hash || base.pathname !== '/') {
  console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (32–256 URL-safe characters) in .env.bot; pass your HTTPS *.workers.dev origin. See bot/CLOUDFLARE.md.');
  process.exit(1);
}

async function call(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Telegram request failed');
  const data = await response.json();
  if (!data.ok) throw new Error('Telegram request rejected');
  return data.result;
}

try {
  await call('setWebhook', {
    url: new URL('/webhook', base).href,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    max_connections: WEBHOOK_CONNECTIONS,
    drop_pending_updates: false,
  });
  const info = await call('getWebhookInfo', {});
  if (info.url !== new URL('/webhook', base).href) throw new Error('Webhook verification failed');
  console.log(`Webhook registered. Pending updates: ${info.pending_update_count ?? 0}. Send /start in Telegram.`);
  if (info.last_error_message) console.log('Telegram reports a recent delivery error. Check Worker configuration and secrets; do not share private logs.');
} catch {
  console.error('Could not register or verify webhook. Check network, token and URL. Sensitive details omitted.');
  process.exitCode = 1;
}

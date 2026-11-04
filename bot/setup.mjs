// Owner-only, mobile-friendly webhook registration. Bot/API tokens never enter
// this page or its URL. Only the existing random webhook secret is submitted.
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
function result(message, status = 200) {
  return new Response(JSON.stringify({ message }), {
    status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function handleSetup(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const nonce = crypto.randomUUID();
    return new Response(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اتصال تلگرام</title>
<style nonce="${nonce}">body{font-family:system-ui;max-width:480px;margin:48px auto;padding:24px;line-height:1.9;background:#f4f7fa;color:#182536}input,button{box-sizing:border-box;font:inherit;width:100%;padding:12px;margin-top:12px;border:1px solid #9aaabd;border-radius:10px}button{background:#175c55;color:white}#status{white-space:pre-wrap}small{display:block}</style>
<h1>اتصال ربات به تلگرام</h1><p>این صفحه فقط برای صاحب ربات است. فقط در آدرس Worker خودتان از آن استفاده کنید.</p>
<p>رمز <b>TELEGRAM_WEBHOOK_SECRET</b> را که قبلاً در تنظیمات Cloudflare ثبت کردید وارد کنید؛ <b>نه توکن تلگرام و نه کلید OpenRouter</b>.</p>
<form id="setup"><label for="secret">رمز اتصال</label><input id="secret" type="password" minlength="32" maxlength="256" pattern="[A-Za-z0-9_-]+" required autocomplete="off" autocapitalize="off" spellcheck="false" dir="ltr"><small>ثبت اتصال، webhook قبلی همین ربات را جایگزین می‌کند. اگر نسخهٔ اجرای دائمی روشن است، اول خاموشش کنید.</small><button id="submit">اتصال به تلگرام</button></form><p id="status" role="status" aria-live="polite"></p>
<script nonce="${nonce}">
const form=document.getElementById('setup'),input=document.getElementById('secret'),button=document.getElementById('submit'),status=document.getElementById('status');
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;status.textContent='در حال اتصال…';const secret=input.value;input.value='';try{const response=await fetch('/setup',{method:'POST',headers:{'X-Setup-Secret':secret,'Content-Type':'application/json'},body:'{}',credentials:'omit',cache:'no-store'});const data=await response.json();status.textContent=data.message||'اتصال انجام نشد.';}catch{status.textContent='خطای ارتباط؛ اتصال اینترنت و آدرس Worker را بررسی کنید.';}finally{button.disabled=false;}});
</script></html>`, {
      headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'` },
    });
  }
  if (request.method !== 'POST') return result('روش درخواست مجاز نیست.', 405);
  // No CORS, query-string credentials, browser GET side effects, or cross-site
  // form submissions. The secret is verified before making any external call.
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') ||
      request.headers.get('Origin') !== url.origin ||
      request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return result('این درخواست باید از صفحهٔ راه‌اندازی همین Worker ارسال شود.', 403);
  }
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) return result('رمز اتصال در تنظیمات Worker ثبت نشده یا قالب آن صحیح نیست.', 503);
  if (request.headers.get('X-Setup-Secret') !== secret) return result('رمز اتصال صحیح نیست. فقط TELEGRAM_WEBHOOK_SECRET را وارد کنید.', 403);
  // Only disclose missing setting names after owner authentication. Never send
  // configured values (including tokens) to the browser, even on failure.
  const required = ['TELEGRAM_BOT_TOKEN', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TELEGRAM_ALLOWED_USER_IDS'];
  const missing = required.filter(name => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) {
    return result(`رمز اتصال پذیرفته شد. این تنظیمات ثبت نشده‌اند یا خالی هستند:\n${missing.join('\n')}\nدر Cloudflare، بخش Settings → Variables and Secrets، فقط همین موارد را تکمیل و Save / Deploy کنید. مقدار کلیدها را در چت نفرستید.`, 503);
  }
  try {
    const fetchImpl = env.fetchImpl || fetch;
    const call = async (method, body) => {
      const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error('Telegram failed');
      const data = await response.json();
      if (!data.ok) throw new Error('Telegram rejected request');
      return data.result;
    };
    const webhook = new URL('/webhook', url.origin).href;
    await call('setWebhook', {
      url: webhook, secret_token: secret, allowed_updates: ['message', 'callback_query'],
      max_connections: 1, drop_pending_updates: false,
    });
    const info = await call('getWebhookInfo', {});
    if (info?.url !== webhook) throw new Error('Webhook verification failed');
    return result('اتصال تلگرام ثبت شد ✅ حالا در چت خصوصی ربات /start بفرستید و بعد یک پیام معمولی برای تست مدل ارسال کنید.');
  } catch {
    // Never return Telegram response bodies or log exceptions with token URLs.
    return result('ثبت یا تأیید اتصال انجام نشد. توکن تلگرام و دسترسی شبکه را در تنظیمات Worker بررسی کنید و دوباره تلاش کنید.', 502);
  }
}

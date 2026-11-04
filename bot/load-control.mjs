// Bounded admission with existing Durable Objects, not a throughput or exactly-once guarantee.
export const INBOX_LIMIT = 5;
export const INBOX_TTL = 10 * 60_000;
export const WORK_LEASE = 4 * 60_000;
export const WEBHOOK_CONNECTIONS = 4;
export const BUSY_TEXT = 'درخواست‌ها زیاد شده و صف فعلاً جا نداره 🌱 کمی بعد دوباره بفرست؛ این پیام برای پردازش پذیرفته نشد.';
export const EXPIRED_TEXT = 'درخواست قبلی بیش از حد در صف موند و پردازش نشد؛ اگر هنوز لازمش داری دوباره بفرست 🌱';
export const asyncUpdates = env => env.BOT_ASYNC_UPDATES !== 'false';
export const updateCommand = update => (update.message?.text || '').trim().split(/\s/)[0].split('@')[0].toLowerCase();
export const priorityUpdate = update => ['/stop', '/reset', '/start', '/weatherstop', '/forgetcity', '/privacy'].includes(updateCommand(update));
export function compactUpdate(update, webhookURL) {
  const out = { update_id: update.update_id, webhookURL };
  const user = from => ({ id: from.id, is_bot: false });
  const chat = value => ({ id: value.id, type: 'private' });
  if (update.callback_query) {
    const c = update.callback_query;
    out.callback_query = { id: c.id, data: c.data, from: user(c.from), message: { message_id: c.message.message_id, chat: chat(c.message.chat) } };
  } else out.message = { from: user(update.message.from), chat: chat(update.message.chat), ...(typeof update.message.text === 'string' ? { text: update.message.text.slice(0, 6001) } : {}) };
  return out;
}
export function nextInboxWake(state) {
  if (!state) return Infinity;
  return Math.min(state.active ? state.active.leaseUntil : (state.pending?.length ? state.nextAt || Date.now() + 100 : Infinity), ...(state.receipts || []).map(r => r.at + 30 * 60_000));
}

export class DurableInbox {
  constructor(storage) { this.storage = storage; this.queue = Promise.resolve(); }
  lock(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  async read() { return await this.storage.get('inbox') || { pending: [], receipts: [], nextAt: null, active: null, retries: 0 }; }
  admit(update, reserve) { return this.lock(async () => {
    const state = await this.read(), now = Date.now();
    state.receipts = state.receipts.filter(r => now - r.at < 30 * 60_000).slice(-199);
    if (state.receipts.some(r => r.id === update.update_id) || state.active?.update.update_id === update.update_id || state.pending.some(j => j.update.update_id === update.update_id)) return { duplicate: true };
    const removed = [];
    const command = updateCommand(update);
    if (command === '/reset') removed.push(...state.pending.splice(0));
    else if (['/start', '/forgetcity'].includes(command)) state.pending = state.pending.filter(j => {
      // A later /start must not silently cancel a queued opt-out.
      if (priorityUpdate(j.update)) return true; removed.push(j); return false;
    });
    if (['/stop', '/weatherstop'].includes(command)) state.pending = state.pending.filter(j => {
      if (['/followup', '/alerts'].includes(updateCommand(j.update))) { removed.push(j); return false; } return true;
    });
    const full = state.pending.length >= INBOX_LIMIT + (priorityUpdate(update) ? 1 : 0);
    const id = 'u' + update.update_id;
    const admitted = !full && await reserve(id, priorityUpdate(update));
    state.receipts.push({ id: update.update_id, at: now });
    if (admitted) {
      const job = { id, update, expiresAt: now + INBOX_TTL };
      if (priorityUpdate(update)) {
        const ordinary = state.pending.findIndex(j => !priorityUpdate(j.update));
        state.pending.splice(ordinary < 0 ? state.pending.length : ordinary, 0, job);
      } else state.pending.push(job);
      // Preserve an existing retry deadline: new arrivals cannot hammer capacity.
      if (!state.nextAt || priorityUpdate(update)) state.nextAt = now + 100;
    }
    const notice = !admitted && (!state.noticeAt || now - state.noticeAt >= 30000);
    if (notice) state.noticeAt = now;
    await this.storage.put('inbox', state);
    return { accepted: admitted, notice, removed: removed.map(j => j.id) };
  }); }
  peek() { return this.lock(async () => {
    const s = await this.read(), now = Date.now();
    if (s.active) return s.active.leaseUntil <= now ? { ...s.active, recovery: true } : null;
    if (!s.pending.length || s.nextAt > now) return null;
    return s.pending[0];
  }); }
  claim(id) { return this.lock(async () => {
    const s = await this.read();
    if ((s.active?.id === id ? s.active : s.pending[0])?.expiresAt <= Date.now()) return null;
    if (s.active?.id === id) { s.active.leaseUntil = Date.now() + WORK_LEASE; await this.storage.put('inbox', s); return s.active; }
    if (s.active || s.pending[0]?.id !== id) return null;
    s.active = { ...s.pending.shift(), leaseUntil: Date.now() + WORK_LEASE };
    s.nextAt = null; s.retries = 0;
    await this.storage.put('inbox', s); return s.active;
  }); }
  finish(id) { return this.lock(async () => {
    const s = await this.read();
    if (s.active?.id === id) s.active = null;
    s.pending = s.pending.filter(j => j.id !== id);
    s.nextAt = s.pending.length ? Date.now() + 100 : null;
    await this.storage.put('inbox', s);
  }); }
  defer(delay, id) { return this.lock(async () => {
    const s = await this.read();
    if (id && (s.active?.id || s.pending[0]?.id) !== id) return;
    s.retries = Math.min(4, (s.retries || 0) + 1);
    const wait = delay || Math.min(30000, 1500 * 2 ** s.retries) + Math.floor(Math.random() * 1000);
    if (s.active) s.active.leaseUntil = Date.now() + wait;
    else if (s.pending.length) s.nextAt = Date.now() + wait;
    await this.storage.put('inbox', s);
  }); }
  cleanup() { return this.lock(async () => {
    const s = await this.read(), now = Date.now();
    s.receipts = s.receipts.filter(r => now - r.at < 30 * 60_000);
    if (!s.pending.length && !s.active && !s.receipts.length) await this.storage.delete('inbox');
    else await this.storage.put('inbox', s);
  }); }
}

// Only opaque update/lease IDs, never chat IDs, texts or provider credentials.
export class CapacityHandler {
  constructor(ctx) { this.storage = ctx.storage; this.queue = Promise.resolve(); }
  fetch(request) { const task = this.queue.then(() => this.handle(request)); this.queue = task.catch(() => {}); return task; }
  async handle(request) {
    const { op, id, priority, kind, ids } = await request.json(), now = Date.now();
    if (!['admit', 'start', 'finish', 'release', 'pause'].includes(op) || (op !== 'release' && (typeof id !== 'string' || !/^(?:u\d+|weather-[a-f0-9-]{36})$/.test(id)))) return new Response('Invalid', { status: 400 });
    const tickets = (await this.storage.get('workTickets') || []).filter(t => Math.max(t.expiresAt, t.leaseUntil || 0) > now);
    let ticket = tickets.find(t => t.id === id), granted = false;
    if (op === 'admit') {
      granted = !!ticket || tickets.length < (priority === true ? 80 : 64);
      if (granted && !ticket) tickets.push({ id, expiresAt: now + INBOX_TTL });
    } else if (op === 'start') {
      if (ticket) {
        const live = tickets.filter(t => t.leaseUntil > now && t.id !== id);
        granted = live.length < 4 && (kind !== 'media' || !live.some(t => t.kind === 'media'));
        if (granted) { ticket.kind = kind === 'media' ? 'media' : 'text'; ticket.leaseUntil = now + WORK_LEASE; }
      }
    } else if (op === 'pause') {
      if (ticket) ticket.leaseUntil = 0;
    } else {
      const remove = op === 'finish' ? [id] : (Array.isArray(ids) ? ids.slice(0, 8) : []);
      for (let i = tickets.length - 1; i >= 0; i--) if (remove.includes(tickets[i].id)) tickets.splice(i, 1);
    }
    await this.storage.put('workTickets', tickets);
    return Response.json({ granted });
  }
}

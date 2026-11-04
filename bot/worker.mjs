import { DurableObject } from 'cloudflare:workers';
import worker, { ChatSession as SessionHandler } from './cloudflare.mjs';
import { MarketFeedHandler } from './live-data.mjs';
import { NewsFeedHandler } from './news.mjs';
import { MediaBudgetHandler } from './media.mjs';

// Keep runtime-only imports in this entrypoint, so the shared handler can also
// be tested with Node's test runner without mocking Cloudflare built-ins.
export class ChatSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.handler = new SessionHandler(ctx, env);
  }
  fetch(request) { return this.handler.fetch(request); }
  alarm() { return this.handler.alarm(); }
}

export class MarketFeed extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.handler = new MarketFeedHandler(ctx, env);
    this.news = new NewsFeedHandler(ctx, env);
  }
  fetch(request) {
    return new URL(request.url).pathname === '/news' ? this.news.fetch() : this.handler.fetch(request);
  }
}

export class MediaBudget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.handler = new MediaBudgetHandler(ctx);
  }
  fetch(request) { return this.handler.fetch(request); }
  alarm() { return this.handler.alarm(); }
}

export default worker;

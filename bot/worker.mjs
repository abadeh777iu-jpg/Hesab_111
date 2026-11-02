import { DurableObject } from 'cloudflare:workers';
import worker, { ChatSession as SessionHandler } from './cloudflare.mjs';

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

export default worker;

// Durable Object wrapper: exposes StoreCore methods over RPC.
import { DurableObject } from 'cloudflare:workers';
import { StoreCore } from './store-core.js';

export class Store extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.core = new StoreCore(ctx.storage.sql);
    }

    findUser(tokenHash) { return this.core.findUser(tokenHash); }
    createUser(input) { return this.core.createUser(input); }
    listUsers() { return this.core.listUsers(); }
    updateUser(id, changes) { return this.core.updateUser(id, changes); }
    inboxAdd(item) { return this.core.inboxAdd(item); }
    inboxList() { return this.core.inboxList(); }
    inboxRemove(id) { return this.core.inboxRemove(id); }
    usageFor(month) { return this.core.usageFor(month); }
    reserveCapture(month, limit) { return this.core.reserveCapture(month, limit); }
    releaseCapture(month) { return this.core.releaseCapture(month); }
    recordTokens(month, input, output) { return this.core.recordTokens(month, input, output); }
    ping() { return 'ok'; }
}

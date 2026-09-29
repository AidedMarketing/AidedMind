// Durable Object wrapper: exposes StoreCore methods over RPC.
import { DurableObject } from 'cloudflare:workers';
import { StoreCore } from './store-core.js';
import { processInbox } from './inbox-processor.js';

export class Store extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.core = new StoreCore(ctx.storage.sql);
    }

    // Queued links are broken down on an alarm, so it happens while the app is
    // closed. Alarms are retried by the platform if a run throws.
    async alarm() {
        await processInbox(this.core, this.env);
        await this.scheduleAlarm();
    }

    async scheduleAlarm() {
        const due = this.core.inboxNextDue();
        if (due !== null) await this.ctx.storage.setAlarm(Math.max(due, Date.now() + 50));
    }

    findUser(tokenHash) { return this.core.findUser(tokenHash); }
    createUser(input) { return this.core.createUser(input); }
    listUsers() { return this.core.listUsers(); }
    updateUser(id, changes) { return this.core.updateUser(id, changes); }
    async inboxAdd(item, options) {
        const added = this.core.inboxAdd(item, options);
        if (added) await this.scheduleAlarm();
        return added;
    }
    inboxList() { return this.core.inboxList(); }
    inboxRemove(id) { return this.core.inboxRemove(id); }
    usageFor(month) { return this.core.usageFor(month); }
    reserveCapture(month, limit) { return this.core.reserveCapture(month, limit); }
    releaseCapture(month) { return this.core.releaseCapture(month); }
    recordTokens(month, input, output) { return this.core.recordTokens(month, input, output); }
    transcriptGet(key) { return this.core.transcriptGet(key); }
    transcriptPut(key, source) { return this.core.transcriptPut(key, source); }
    addCost(month, item, amount) { return this.core.addCost(month, item, amount); }
    costsFor(month) { return this.core.costsFor(month); }
    metaGet(key) { return this.core.metaGet(key); }
    metaSet(key, value) { return this.core.metaSet(key, value); }
    ping() { return 'ok'; }
}

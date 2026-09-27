// Holding area for links shared from the iOS Shortcut. On iPhone a
// home-screen web app can't receive shares directly, so the Shortcut posts
// here and the app drains the inbox (and analyzes each item against the local
// library) the next time it opens. Stored as a small JSON file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ITEMS = 200;
const MAX_TEXT = 600000;

class Inbox {
    constructor(filePath) {
        this.filePath = filePath;
        this.items = [];
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Array.isArray(data)) this.items = data;
        } catch {
            this.items = [];
        }
    }

    persist() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.items));
        fs.renameSync(tmp, this.filePath);
    }

    add({ url, text, title }) {
        const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
        const item = {
            id: crypto.randomUUID(),
            url: clean(url, 4096),
            text: clean(text, MAX_TEXT),
            title: clean(title, 300),
            receivedAt: new Date().toISOString()
        };
        if (!item.url && !item.text) {
            const error = new Error('Nothing to save: send a url or text.');
            error.status = 400;
            throw error;
        }
        this.items.push(item);
        if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS);
        this.persist();
        return item;
    }

    list() {
        return [...this.items];
    }

    remove(id) {
        const before = this.items.length;
        this.items = this.items.filter((item) => item.id !== id);
        if (this.items.length !== before) this.persist();
        return before !== this.items.length;
    }
}

module.exports = { Inbox };

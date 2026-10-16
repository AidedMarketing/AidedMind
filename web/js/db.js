// IndexedDB persistence for notes. Everything stays on this device.
const DB_NAME = 'aidedmind';
const DB_VERSION = 1;
const STORE = 'notes';

let dbPromise;

function open() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt');
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    return dbPromise;
}

async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const result = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function allNotes() {
    const notes = await run('readonly', (store) => store.getAll());
    return (notes || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveNote(note) {
    return run('readwrite', (store) => store.put({ ...note, updatedAt: new Date().toISOString() }));
}

export function saveMany(notes) {
    return run('readwrite', (store) => notes.forEach((note) => store.put(note)));
}

export function deleteNote(id) {
    return run('readwrite', (store) => store.delete(id));
}

export function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Read and change a collection in one transaction, preserving fields written by
// concurrent background results. The transform must be synchronous and pure.
export async function updateMany(transform) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const request = store.getAll();
        const change = { before: [], after: [] };
        let failure;
        request.onsuccess = () => {
            try {
                const before = request.result;
                const updated = transform(before);
                if (updated.length !== before.length) throw new Error('A collection update must retain every piece.');
                updated.forEach((note, index) => {
                    if (note === before[index]) return;
                    if (note.id !== before[index]?.id) throw new Error('A collection update cannot change piece identity.');
                    const saved = { ...note, updatedAt: new Date().toISOString() };
                    store.put(saved); change.before.push(before[index]); change.after.push(saved);
                });
            } catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(change);
        tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Could not save library changes.'));
    });
}

// Patch one record inside a transaction so a background connection result
// cannot overwrite a personal note saved while the model request was running.
export async function updateNote(id, update) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const request = store.get(id);
        let updated;
        let failure;
        request.onsuccess = () => {
            if (!request.result) return;
            try {
                updated = update(request.result);
                if (updated) store.put({ ...updated, id, updatedAt: new Date().toISOString() });
            } catch (error) { failure = error; tx.abort(); }
        };
        tx.oncomplete = () => resolve(updated);
        tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Could not save this piece.'));
    });
}

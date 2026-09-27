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

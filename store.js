// Tiny IndexedDB wrapper. Clips are kept here (not in the camera roll) until Drive confirms the upload.
const DB_NAME = 'grok-film';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('clips')) db.createObjectStore('clips', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

/** Clip metadata (small, rewritten often). */
export const clipsStore = {
  put: (c) => tx('clips', 'readwrite', (s) => s.put(c)),
  get: (id) => tx('clips', 'readonly', (s) => s.get(id)),
  del: (id) => tx('clips', 'readwrite', (s) => s.delete(id)),
  all: () => tx('clips', 'readonly', (s) => s.getAll())
};

/** Video bytes (big, written once, deleted after a confirmed upload). */
export const blobStore = {
  async put(id, blob) {
    try {
      await tx('blobs', 'readwrite', (s) => s.put(blob, id));
    } catch (e) {
      // Older Safari builds refused Blobs in IndexedDB; store raw bytes instead.
      const buf = await blob.arrayBuffer();
      await tx('blobs', 'readwrite', (s) => s.put({ __buf: buf, type: blob.type }, id));
    }
  },
  async get(id) {
    const v = await tx('blobs', 'readonly', (s) => s.get(id));
    if (v && v.__buf) return new Blob([v.__buf], { type: v.type });
    return v || null;
  },
  del: (id) => tx('blobs', 'readwrite', (s) => s.delete(id))
};

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  del: (k) => tx('kv', 'readwrite', (s) => s.delete(k))
};

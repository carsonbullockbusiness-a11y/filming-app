// Tiny IndexedDB wrapper. Clips are kept here (not in the camera roll) until Drive confirms the upload.
const DB_NAME = 'grok-film';
const DB_VERSION = 2; // v2 adds 'recparts' (crash-safe recording pieces)
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
        if (!db.objectStoreNames.contains('recparts')) db.createObjectStore('recparts');
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

/**
 * Pieces of the take being recorded (MediaRecorder timeslice), written to disk as they arrive so a
 * long 4K take is not held in memory and survives Safari being killed. Key: "<recId>:<000123>".
 */
const partKey = (recId, seq) => `${recId}:${String(seq).padStart(6, '0')}`;
export const recParts = {
  async put(recId, seq, blob) {
    try {
      await tx('recparts', 'readwrite', (s) => s.put(blob, partKey(recId, seq)));
    } catch (e) {
      const buf = await blob.arrayBuffer();
      await tx('recparts', 'readwrite', (s) => s.put({ __buf: buf, type: blob.type }, partKey(recId, seq)));
    }
  },
  async list(recId) {
    const range = IDBKeyRange.bound(recId + ':', recId + ':\uffff');
    const keys = await tx('recparts', 'readonly', (s) => s.getAllKeys(range));
    const vals = await tx('recparts', 'readonly', (s) => s.getAll(range));
    return (keys || []).map((k, i) => {
      const v = vals[i];
      return { seq: Number(String(k).split(':')[1]), blob: v && v.__buf ? new Blob([v.__buf], { type: v.type }) : v };
    });
  },
  delAll: (recId) => tx('recparts', 'readwrite', (s) => s.delete(IDBKeyRange.bound(recId + ':', recId + ':\uffff'))),
  async recIds() {
    const keys = await tx('recparts', 'readonly', (s) => s.getAllKeys());
    return [...new Set((keys || []).map((k) => String(k).split(':')[0]))];
  }
};

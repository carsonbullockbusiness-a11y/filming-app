// Upload queue: sends each saved clip to the Apps Script receiver in 4 MB pieces,
// resumes after network drops, and deletes the clip from the phone only after
// the receiver confirms Drive has the full file (byte count matches).
import { CHUNK_BYTES } from './shared.js';

export class ApiError extends Error {
  constructor(message, code, fatal = false) {
    super(message);
    this.code = code;
    this.fatal = fatal;
  }
}

const ERROR_TEXT = {
  bad_key: 'Wrong upload key. Open the setup link again (Settings).',
  no_config: 'Not connected yet. Open Settings and paste the setup link.',
  'bad brand': 'Brand name has odd characters.',
  'bad part': 'Pick Hook, Insert, Demo or CTA.',
  'bad video': 'Video number must be 1 to 50.',
  'bad workflow': 'Workflow name: letters and numbers only (max 40).'
};

export async function blobToBase64(blob) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export function createUploader({
  clips, blobs, getConfig, onChange = () => {},
  fetchImpl = (...a) => fetch(...a), toBase64 = blobToBase64,
  timeoutMs = 120000, now = () => Date.now(), isOnline = () => (typeof navigator === 'undefined' || navigator.onLine !== false)
}) {
  let running = false;
  let rerun = false;
  let timer = null;
  const progress = new Map();

  async function api(body) {
    const cfg = getConfig() || {};
    if (!cfg.url || !cfg.key) throw new ApiError(ERROR_TEXT.no_config, 'no_config', true);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let text;
    try {
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // "simple" request: no CORS preflight
        body: JSON.stringify(Object.assign({}, body, { key: cfg.key })),
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined
      });
      text = await res.text();
    } catch (e) {
      throw new ApiError('Network problem: ' + ((e && e.message) || e), 'network');
    } finally {
      if (t) clearTimeout(t);
    }
    let j;
    try { j = JSON.parse(text); } catch (e) {
      throw new ApiError('Receiver sent a non-JSON reply. Check the Web app URL, and that access is set to "Anyone".', 'not_json');
    }
    if (!j || !j.ok) {
      const code = (j && j.error) || 'unknown';
      throw new ApiError(ERROR_TEXT[code] || String(code), code, code === 'bad_key');
    }
    return j;
  }

  function setProgress(id, sent, total) {
    progress.set(id, { sent, total });
  }

  async function finish(c, r, blob) {
    if (Number(r.size) !== blob.size) {
      Object.assign(c, { status: 'error', error: `Drive copy is ${r.size} bytes, phone has ${blob.size}. Kept on phone.`, retryAt: Infinity });
      await clips.put(c);
      onChange(c);
      return;
    }
    await blobs.del(c.id); // confirmed: free the space on the phone
    Object.assign(c, {
      status: 'done', fileId: r.fileId, fileName: r.name || c.fileName, link: r.link || '',
      folder: r.folder || c.folder, doneAt: now(), error: '', offset: blob.size, size: blob.size
    });
    await clips.put(c);
    progress.delete(c.id);
    onChange(c);
  }

  async function uploadOne(c) {
    const blob = await blobs.get(c.id);
    if (!blob) {
      Object.assign(c, { status: 'error', error: 'Video data is missing on this phone.', retryAt: Infinity });
      await clips.put(c);
      onChange(c);
      return;
    }
    c.status = 'uploading';
    c.error = '';
    c.size = blob.size;
    await clips.put(c);
    setProgress(c.id, c.offset || 0, blob.size);
    onChange(c);

    if (!c.uploadId) {
      const r = await api({
        action: 'start', clipId: c.id, brand: c.brand, part: c.part, note: c.note || '',
        recordedAt: c.recordedAt, mimeType: c.mime || blob.type, size: blob.size,
        durationSec: c.durationSec || null, camera: c.camera || '', source: c.source || 'camera', origName: c.origName || '',
        video: c.demo ? null : (c.video || null), demo: c.demo || null, day: c.day || null, width: c.width || null, height: c.height || null, fps: c.fps || null
      });
      if (r.done) return finish(c, r, blob);
      c.uploadId = r.uploadId;
      c.fileName = r.name || c.fileName;
      c.folder = r.folder || c.folder;
      c.offset = r.offset || 0;
      c.chunk = r.chunkSize || CHUNK_BYTES;
      await clips.put(c);
    }

    const chunk = c.chunk || CHUNK_BYTES;
    let stalls = 0;
    for (;;) {
      let r;
      if (c.offset >= blob.size) {
        r = await api({ action: 'status', uploadId: c.uploadId, clipId: c.id });
      } else {
        const end = Math.min(blob.size, c.offset + chunk);
        const data = await toBase64(blob.slice(c.offset, end));
        try {
          r = await api({ action: 'chunk', uploadId: c.uploadId, clipId: c.id, offset: c.offset, data });
        } catch (e) {
          if (e.code !== 'network' && e.code !== 'not_json') throw e;
          // The piece may or may not have landed; ask Drive where it stands.
          r = await api({ action: 'status', uploadId: c.uploadId, clipId: c.id });
        }
      }
      if (r.done) return finish(c, r, blob);
      if (r.restart) {
        c.uploadId = null;
        c.offset = 0;
        await clips.put(c);
        throw new ApiError('Upload link expired, starting this clip over.', 'restart');
      }
      if (typeof r.offset !== 'number' || r.offset < 0 || r.offset > blob.size) throw new ApiError('Odd reply from receiver.', 'bad_status');
      if (r.offset <= c.offset) {
        if (++stalls >= 3) throw new ApiError('Upload is not moving forward. Will retry.', 'stalled');
      } else {
        stalls = 0;
      }
      c.offset = r.offset;
      await clips.put(c);
      setProgress(c.id, c.offset, blob.size);
      onChange(c);
    }
  }

  function backoff(tries, code) {
    if (code === 'restart') return 500;
    return Math.min(5 * 60 * 1000, 3000 * Math.pow(2, Math.max(0, tries - 1)));
  }

  async function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    const all = await clips.all();
    const waits = all.filter((c) => c.status === 'error' && Number.isFinite(c.retryAt)).map((c) => c.retryAt - now());
    if (waits.length) timer = setTimeout(run, Math.max(250, Math.min(...waits)));
  }

  async function run() {
    if (running) { rerun = true; return; }
    running = true;
    try {
      do {
        rerun = false;
        for (;;) {
          const cfg = getConfig() || {};
          if (!cfg.url || !cfg.key || !isOnline()) break;
          const all = await clips.all();
          const t = now();
          const next = all
            .filter((c) => c.status === 'queued' || c.status === 'uploading' || (c.status === 'error' && (c.retryAt || 0) <= t))
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
          if (!next) break;
          try {
            await uploadOne(next);
          } catch (e) {
            next.tries = (next.tries || 0) + 1;
            next.status = 'error';
            next.error = (e && e.message) || String(e);
            next.retryAt = e && e.fatal ? Infinity : now() + backoff(next.tries, e && e.code);
            await clips.put(next);
            progress.delete(next.id);
            onChange(next);
            if (e && e.fatal) break;
          }
        }
      } while (rerun);
    } finally {
      running = false;
    }
    await schedule();
  }

  async function retry(id) {
    const c = await clips.get(id);
    if (c && c.status === 'error') {
      c.status = 'queued';
      c.retryAt = 0;
      c.tries = 0;
      await clips.put(c);
    }
    return run();
  }

  async function retryAll() {
    for (const c of await clips.all()) {
      if (c.status === 'error') {
        c.status = 'queued';
        c.retryAt = 0;
        c.tries = 0;
        await clips.put(c);
      }
    }
    return run();
  }

  return {
    run, retry, retryAll,
    isRunning: () => running,
    progressOf: (id) => progress.get(id) || null,
    ping: () => api({ action: 'ping' }),
    saveBatch: (b) => api(Object.assign({ action: 'batch' }, b)),
    // Video folders (v0.2): read a brand's day, save one video's links/notes, mark a video done (notifies the editor).
    getDay: (brand, date) => api({ action: 'day', brand, date }),
    saveVideo: (v) => api(Object.assign({ action: 'video' }, v)),
    markDone: (v) => api(Object.assign({ action: 'done' }, v)),
    // 0.4: demo bank, finals review feed, batch planner
    demos: (brand) => api({ action: 'demos', brand }),
    addDemoWorkflow: (brand, workflow) => api({ action: 'demoAdd', brand, workflow }),
    finals: (o = {}) => api(Object.assign({ action: 'finals' }, o)),
    readFinal: (fileId, offset) => api({ action: 'fread', fileId, offset }),
    review: (fileId, decision, note) => api({ action: 'review', fileId, decision, note }),
    plan: () => api({ action: 'plan' }),
    setSessions: (brand, sessions) => api({ action: 'sessions', brand, sessions })
  };
}

// Upload queue (0.4.2). The receiver opens a Drive resumable session; the phone then PUTs the bytes
// STRAIGHT to that session in 16 MB pieces (no base64, no Apps Script in the data path), so 1–3 GB 4K
// clips go through. If the phone can't talk to Drive directly (CORS/network), the same session is fed
// through the receiver in 8 MB pieces instead. Every piece resumes from what Drive actually has
// (asked via the receiver), so a dropped connection, a locked phone or a closed app never restarts
// the clip. A clip leaves the phone only after the receiver confirms Drive has every byte.
// Nothing here ever deletes a clip that isn't confirmed in Drive.
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
  clips, blobs, getConfig, onChange = () => {}, keepBlob = () => false,
  fetchImpl = (...a) => fetch(...a), toBase64 = blobToBase64, putImpl = null,
  origin = (typeof location !== 'undefined' && location.origin) || '',
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

  /** PUT one piece straight to the Drive session. Returns the HTTP status (0 = blocked/no network). */
  async function directPut(url, body, start, size) {
    const end = start + body.size - 1;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), Math.max(timeoutMs, 300000)) : null;
    try {
      const res = await (putImpl || fetchImpl)(url, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end}/${size}` }, body, signal: ctrl ? ctrl.signal : undefined });
      return res.status;
    } catch (e) {
      return 0;
    } finally {
      if (t) clearTimeout(t);
    }
  }

  /** Read a slice; if the phone's copy hiccups, fetch it again from storage once (never give up on the clip). */
  async function readSlice(c, blob, a, b) {
    try { return await toBase64(blob.slice(a, b)); } catch (e) {
      const again = await blobs.get(c.id);
      if (!again) throw new ApiError('Waiting for the phone to hand over the video file (it is kept).', 'read');
      return toBase64(again.slice(a, b));
    }
  }

  async function finish(c, r, blob) {
    if (Number(r.size) !== blob.size) {
      Object.assign(c, { status: 'error', error: `Drive copy is ${r.size} bytes, phone has ${blob.size}. Kept on phone.`, retryAt: Infinity });
      await clips.put(c);
      onChange(c);
      return;
    }
    if (keepBlob(c)) c.blobKept = true; // app keeps a few for playback this session; deleted on next launch
    else await blobs.del(c.id); // confirmed: free the space on the phone
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
      // Never tell him to refilm: the record stays and is retried; storage can be briefly unreadable on iOS.
      throw new ApiError('Waiting for the video file on this phone (nothing deleted). Will retry.', 'no_blob');
    }
    c.status = 'uploading';
    c.error = '';
    c.size = blob.size;
    await clips.put(c);
    setProgress(c.id, c.offset || 0, blob.size);
    onChange(c);

    const startBody = (extra) => Object.assign({
      action: 'start', clipId: c.id, brand: c.brand, part: c.part, note: c.note || '',
      recordedAt: c.recordedAt, mimeType: c.mime || blob.type, size: blob.size, origin,
      durationSec: c.durationSec || null, camera: c.camera || '', source: c.source || 'camera', origName: c.origName || '',
      video: c.demo ? null : (c.video || null), demo: c.demo || null, day: c.day || null, width: c.width || null, height: c.height || null, fps: c.fps || null
    }, extra);
    if (!c.uploadId) {
      const r = await api(startBody());
      if (r.done) return finish(c, r, blob);
      c.uploadId = r.uploadId;
      c.fileName = r.name || c.fileName;
      c.folder = r.folder || c.folder;
      c.offset = r.offset || 0;
      c.chunk = r.chunkSize || CHUNK_BYTES;
      c.session = r.sessionUrl || null;
      c.dchunk = r.directChunk || 16 * 1024 * 1024;
      await clips.put(c);
    } else if (c.offset > 0 || c.session === undefined) {
      // Resuming (app reopened, retry): ask Drive where this clip stands before sending anything.
      // A clip stuck on a pre-0.4.2 relay-only session gets a fresh direct session (fresh: true); bytes are re-sent from 0.
      let st = await api(startBody());
      if (!st.done && st.uploadId && !st.sessionUrl && st.directChunk && origin && c.session === undefined) st = await api(startBody({ fresh: true }));
      if (st.done) return finish(c, st, blob);
      if (st.uploadId) { c.uploadId = st.uploadId; c.offset = st.offset || 0; if (st.sessionUrl) c.session = st.sessionUrl; if (st.directChunk) c.dchunk = st.directChunk; }
      if (c.session === undefined) c.session = st.sessionUrl || null;
      await clips.put(c);
      setProgress(c.id, c.offset, blob.size);
    }

    const chunk = c.chunk || CHUNK_BYTES;
    const status = () => api({ action: 'status', uploadId: c.uploadId, clipId: c.id });
    let stalls = 0;
    for (;;) {
      let r;
      const direct = !!c.session && !c.relayOnly;
      if (c.offset >= blob.size) {
        r = await status();
      } else if (direct) {
        const end = Math.min(blob.size, c.offset + (c.dchunk || 16 * 1024 * 1024));
        const code = await directPut(c.session, blob.slice(c.offset, end), c.offset, blob.size);
        if (code === 308 && c.directOk) {
          r = { ok: true, done: false, offset: end };
          c.sinceCheck = (c.sinceCheck || 0) + 1;
          if (c.sinceCheck >= 8) { c.sinceCheck = 0; r = await status(); } // trust but verify every 8 pieces
        } else if (code === 404 || code === 410) {
          r = await status(); // receiver confirms and restarts cleanly
        } else {
          // 200/201 (last piece), first piece, 5xx, or blocked/no network: ask Drive what it really has.
          r = await status();
          if (!r.done && !r.restart && typeof r.offset === 'number' && r.offset > c.offset) { c.directOk = true; c.sinceCheck = 0; }
          else if (!r.done && !r.restart && !c.directOk && (code === 0 || code >= 400)) {
            c.relayOnly = true; // this phone can't reach Drive directly: send the rest through the receiver
            await clips.put(c);
            continue;
          } else if (code === 0 && !r.done) throw new ApiError('Network problem: connection dropped. Resuming from ' + Math.round(c.offset / 1048576) + ' MB.', 'network');
        }
      } else {
        const end = Math.min(blob.size, c.offset + chunk);
        const data = await readSlice(c, blob, c.offset, end);
        try {
          r = await api({ action: 'chunk', uploadId: c.uploadId, clipId: c.id, offset: c.offset, data });
        } catch (e) {
          if (e.code !== 'network' && e.code !== 'not_json' && !/^drive_5/.test(e.code)) throw e;
          // The piece may or may not have landed; ask Drive where it stands.
          r = await status();
        }
      }
      if (r.done) return finish(c, r, blob);
      if (r.restart) {
        c.uploadId = null;
        c.session = null;
        c.directOk = false;
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

  let stopped = false;
  async function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (stopped) return;
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
    stop: () => { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
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

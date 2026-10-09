import {
  BRANDS, PARTS, APP_VERSION, ptDayKey, ptDayFolderName, ptClock, clipName, pickMimeType,
  decodeSetup, fmtDur, fmtBytes, ringColor, isHttpUrl, uid
} from './shared.js';
import { clipsStore, blobStore, kv } from './store.js';
import { createUploader } from './uploader.js';
import { Compositor } from './effects.js';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('gf.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('gf.' + k, JSON.stringify(v)); } catch (e) { /* storage full / private */ } }
};
const DEFAULTS = {
  brand: 'Higgsfield', part: 'HOOK', facing: 'user', lensId: '',
  ring: { on: false, bright: 100, warm: 50, size: 12 },
  gs: 'off', countdown: 0, grid: 0,
  script: { on: false, text: '', speed: 35, size: 28 },
  quality: '1080', maxLen: 0, brands: []
};
const stored = LS.get('prefs', {});
const prefs = Object.assign({}, DEFAULTS, stored, {
  ring: Object.assign({}, DEFAULTS.ring, stored.ring),
  script: Object.assign({}, DEFAULTS.script, stored.script)
});
const savePrefs = () => LS.set('prefs', prefs);
let cfg = LS.get('cfg', { url: '', key: '' });
const allBrands = () => BRANDS.concat((prefs.brands || []).filter((b) => !BRANDS.includes(b)));
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const video = $('cam');
const fxCanvas = $('fx');
const comp = new Compositor(video, fxCanvas);
let stream = null;
let lenses = [];

let refreshTimer = null;
const uploader = createUploader({
  clips: clipsStore,
  blobs: blobStore,
  getConfig: () => cfg,
  onChange: () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshQueueUI(); }, 300);
  }
});

/* ------------------------------------------------------------------ */
/* Small UI helpers                                                    */
/* ------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function camMsg(msg) { $('camMsg').textContent = msg; $('camMsg').hidden = !msg; }

let openSheetId = null;
function openSheet(id) {
  closePanels();
  if (openSheetId && openSheetId !== id) {
    if (openSheetId === 's-batch') persistBatchFields();
    $(openSheetId).hidden = true;
  }
  openSheetId = id;
  $(id).hidden = false;
  $('backdrop').hidden = false;
}
function closeSheet() {
  if (!openSheetId) return;
  const id = openSheetId;
  if (id === 's-batch') persistBatchFields();
  if (id === 's-review') { discardReview(true); return; }
  $(id).hidden = true;
  $('backdrop').hidden = true;
  openSheetId = null;
}

const PANELS = { ringBtn: 'p-ring', gsBtn: 'p-gs', scriptBtn: 'p-script' };
function closePanels() { Object.values(PANELS).forEach((p) => { $(p).hidden = true; }); }
function togglePanel(btnId) {
  const id = PANELS[btnId];
  const wasOpen = !$(id).hidden;
  closePanels();
  if (!wasOpen) $(id).hidden = false;
  return !wasOpen;
}

function renderChips(el, items, current, onPick, cls = '') {
  el.innerHTML = items.map((v) => `<button class="chip ${cls} ${v === current ? 'on' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    el.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    onPick(b.dataset.v);
  };
}

/* ------------------------------------------------------------------ */
/* Setup link (#setup=...) and connection                              */
/* ------------------------------------------------------------------ */
function consumeSetupHash() {
  const m = /[#&]setup=([^&]+)/.exec(location.hash);
  if (!m) return;
  const s = decodeSetup(decodeURIComponent(m[1]));
  if (!s) { toast('That setup link looks broken. Ask Grok Bot for a new one.'); return; }
  const changed = s.url !== cfg.url || s.key !== cfg.key;
  cfg = s;
  LS.set('cfg', cfg);
  // Keep the hash while in Safari so "Add to Home Screen" carries the connection into the app.
  if (isStandalone) history.replaceState(null, '', location.pathname + location.search);
  if (changed) toast('Connected to your Drive ✓');
}

function setConn(msg, kind = '') {
  const el = $('connState');
  el.textContent = msg;
  el.className = 'conn ' + kind;
}

async function testConn() {
  if (!cfg.url || !cfg.key) { setConn('Not connected yet. Paste the setup link above.', 'bad'); return; }
  setConn('Testing…');
  try {
    const r = await uploader.ping();
    setConn(`Connected ✓ Saving to "${r.root}". Today's folder: ${r.today}`, 'ok');
    uploader.retryAll();
  } catch (e) {
    setConn(e.message, 'bad');
  }
  refreshQueueUI();
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

function streamLive() {
  return stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
}

async function startCamera() {
  if (recording) return;
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    camMsg(window.isSecureContext ? 'This browser cannot use the camera.' : 'The camera only works on the https:// link.');
    return;
  }
  const q = prefs.quality === '4k' ? [3840, 2160] : prefs.quality === '720' ? [1280, 720] : [1920, 1080];
  const v = { width: { ideal: q[0] }, height: { ideal: q[1] }, frameRate: { ideal: 30 } };
  if (prefs.facing === 'environment' && prefs.lensId) v.deviceId = { exact: prefs.lensId };
  else v.facingMode = { ideal: prefs.facing };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: true });
  } catch (e) {
    if (v.deviceId) { prefs.lensId = ''; savePrefs(); return startCamera(); }
    camMsg(e && e.name === 'NotAllowedError'
      ? 'Camera or mic is blocked. iPhone Settings › Apps › Safari › Camera and Microphone › Allow, then reopen.'
      : 'Camera error: ' + ((e && e.message) || e));
    return;
  }
  camMsg('');
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => {});
  applyMirror();
  listLenses();
  wake(true);
  setTimeout(updateCamInfo, 800);
}

function applyMirror() {
  const m = prefs.facing === 'user';
  video.classList.toggle('mirror', m);
  fxCanvas.classList.toggle('mirror', m);
}

async function listLenses() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const back = devs.filter((d) => /back|rear|environment/i.test(d.label) && !/dual|triple/i.test(d.label));
    const order = { '0.5x': 0, '1x': 1, Zoom: 2 };
    lenses = back.map((d) => ({ id: d.deviceId, label: /ultra/i.test(d.label) ? '0.5x' : /tele/i.test(d.label) ? 'Zoom' : '1x' }))
      .sort((a, b) => order[a.label] - order[b.label]);
  } catch (e) { lenses = []; }
  const show = prefs.facing === 'environment' && lenses.length > 1;
  $('lensBtn').hidden = !show;
  if (show) {
    const cur = lenses.find((l) => l.id === prefs.lensId) || lenses.find((l) => l.label === '1x') || lenses[0];
    $('lensLabel').textContent = cur.label;
  }
}

function updateCamInfo() {
  const t = stream && stream.getVideoTracks()[0];
  const s = t && t.getSettings ? t.getSettings() : {};
  $('camInfo').textContent = t
    ? `Camera: ${video.videoWidth || s.width || '?'}×${video.videoHeight || s.height || '?'} at ${Math.round(s.frameRate || 30)} fps. Recording format: ${pickMimeType((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || 'browser default'}.`
    : '';
}

let wakeLock = null;
async function wake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) { /* not supported */ }
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */
let recorder = null;
let recording = false;
let recChunks = [];
let recStartedAt = 0;
let recTimer = null;
let fxTrack = null;
let recMeta = null;
let countdownCancel = null;

async function onRecButton() {
  closePanels();
  if (countdownCancel) { countdownCancel(); return; }
  if (recording) { stopRecording(); return; }
  if (!window.MediaRecorder) { toast('This browser cannot record video. Update iOS (14.3 or newer).'); return; }
  if (!streamLive()) { await startCamera(); if (!streamLive()) return; }
  if (prefs.countdown) {
    const go = await runCountdown(prefs.countdown);
    if (!go) return;
  }
  startRecording();
}

function runCountdown(n) {
  return new Promise((resolve) => {
    const el = $('count');
    let left = n;
    el.textContent = left;
    el.hidden = false;
    document.body.classList.add('counting');
    const iv = setInterval(() => {
      left -= 1;
      if (left <= 0) done(true);
      else el.textContent = left;
    }, 1000);
    function done(ok) {
      clearInterval(iv);
      el.hidden = true;
      document.body.classList.remove('counting');
      countdownCancel = null;
      resolve(ok);
    }
    countdownCancel = () => done(false);
  });
}

function startRecording() {
  let recStream = stream;
  if (comp.active) {
    if (comp.canRecord) {
      fxTrack = comp.captureTrack(30);
      recStream = new MediaStream([fxTrack].concat(stream.getAudioTracks()));
    } else {
      toast('This phone cannot record the background effect, recording the plain camera.');
    }
  }
  const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
  const bits = prefs.quality === '4k' ? 35e6 : prefs.quality === '720' ? 5e6 : 12e6;
  const opts = { videoBitsPerSecond: bits, audioBitsPerSecond: 128000 };
  if (mime) opts.mimeType = mime;
  try {
    recorder = new MediaRecorder(recStream, opts);
  } catch (e) {
    try { recorder = new MediaRecorder(recStream); } catch (e2) { toast('Could not start recording: ' + e2.message); return; }
  }
  recChunks = [];
  recMeta = { recordedAt: Date.now(), camera: prefs.facing === 'user' ? 'front' : 'back', effect: comp.active ? prefs.gs : 'none' };
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = onRecorderStop;
  recorder.onerror = (e) => toast('Recording error: ' + ((e.error && e.error.message) || 'unknown'));
  recorder.start();
  recording = true;
  recStartedAt = performance.now();
  document.body.classList.add('recording');
  $('recTime').textContent = '0:00';
  $('recTime').hidden = false;
  recTimer = setInterval(tickRec, 250);
  startPrompter();
  wake(true);
}

function tickRec() {
  const s = (performance.now() - recStartedAt) / 1000;
  $('recTime').textContent = fmtDur(s);
  if (prefs.maxLen && s >= prefs.maxLen) stopRecording();
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  clearInterval(recTimer);
  recMeta.durationSec = Math.round((performance.now() - recStartedAt) / 100) / 10;
  try { recorder.stop(); } catch (e) { /* already stopped */ }
  document.body.classList.remove('recording');
  $('recTime').hidden = true;
  stopPrompter();
}

async function onRecorderStop() {
  if (fxTrack) { fxTrack.stop(); fxTrack = null; }
  const type = ((recorder && recorder.mimeType) || (recChunks[0] && recChunks[0].type) || 'video/mp4').split(';')[0];
  const blob = new Blob(recChunks, { type });
  recChunks = [];
  if (!blob.size) { toast('Nothing was recorded. Try again.'); return; }
  const c = {
    id: uid(), createdAt: Date.now(), recordedAt: recMeta.recordedAt, durationSec: recMeta.durationSec,
    mime: type, size: blob.size, camera: recMeta.camera, effect: recMeta.effect, source: 'camera',
    brand: prefs.brand, part: prefs.part, note: '', status: 'draft'
  };
  try {
    await blobStore.put(c.id, blob);
    await clipsStore.put(c);
  } catch (e) {
    toast('Phone storage is full. Clear space, then try again.', 5000);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  openReview([c], [blob]);
}

/* ------------------------------------------------------------------ */
/* Review + tag (after a take, or after importing clips)              */
/* ------------------------------------------------------------------ */
const review = { items: null, blobs: null, brand: '', part: '', url: null };

function openReview(items, blobs) {
  review.items = items;
  review.blobs = blobs;
  review.brand = items[0].brand || prefs.brand;
  review.part = items[0].part === 'REF' ? 'HOOK' : (items[0].part || prefs.part);
  if (review.url) URL.revokeObjectURL(review.url);
  review.url = URL.createObjectURL(blobs[0]);
  const v = $('reviewVid');
  v.src = review.url;
  v.play().catch(() => {});
  $('reviewNote').value = items[0].note || '';
  renderChips($('reviewBrands'), allBrands(), review.brand, (b) => { review.brand = b; reviewInfo(); });
  renderChips($('reviewParts'), PARTS, review.part, (p) => { review.part = p; reviewInfo(); }, 'part');
  $('retakeBtn').textContent = items[0].source === 'camera' ? 'Retake' : 'Cancel';
  $('photosBtn').hidden = !(navigator.canShare && items.length === 1);
  reviewInfo();
  openSheet('s-review');
}

function reviewInfo() {
  const c = review.items[0];
  const size = review.blobs.reduce((n, b) => n + b.size, 0);
  const name = clipName(review.part, review.brand, new Date(c.recordedAt), c.mime, c.origName);
  $('reviewInfo').textContent = (review.items.length > 1 ? `${review.items.length} clips · ` : '') +
    (c.durationSec ? fmtDur(c.durationSec) + ' · ' : '') + fmtBytes(size) +
    ` → ${review.brand} / ${ptDayFolderName(new Date(c.recordedAt))} / ${review.items.length > 1 ? review.part + '_…' : name}`;
}

function hideReview() {
  const v = $('reviewVid');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (review.url) { URL.revokeObjectURL(review.url); review.url = null; }
  review.items = null;
  review.blobs = null;
  $('s-review').hidden = true;
  $('backdrop').hidden = true;
  openSheetId = null;
}

async function saveReview() {
  if (!review.items) return;
  const note = $('reviewNote').value.trim();
  const first = review.items[0];
  for (const c of review.items) {
    Object.assign(c, { brand: review.brand, part: review.part, note, status: 'queued' });
    await clipsStore.put(c);
  }
  prefs.brand = review.brand;
  prefs.part = review.part;
  savePrefs();
  renderTop();
  const where = `${review.brand} / ${ptDayFolderName(new Date(first.recordedAt))}`;
  hideReview();
  toast(cfg.url ? `Saved ✓ Uploading to ${where}` : 'Saved on this phone. Connect Drive in Settings to upload.');
  refreshQueueUI();
  uploader.run();
}

async function discardReview(fromBackdrop = false) {
  if (!review.items) { hideReview(); return; }
  const c = review.items[0];
  if (fromBackdrop) {
    // Tapping outside keeps the clip as an untagged draft (find it in Batch).
    hideReview();
    toast('Kept as a draft. Tag it from Batch.');
    refreshQueueUI();
    return;
  }
  if (c.source === 'camera' && (c.durationSec || 0) > 5 && !confirm('Delete this take?')) return;
  for (const x of review.items) {
    await blobStore.del(x.id).catch(() => {});
    await clipsStore.del(x.id).catch(() => {});
  }
  hideReview();
  refreshQueueUI();
}

async function saveToPhotos() {
  if (!review.items) return;
  const c = review.items[0];
  const name = clipName(review.part, review.brand, new Date(c.recordedAt), c.mime, c.origName);
  const file = new File([review.blobs[0]], name, { type: c.mime || 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { /* cancelled */ }
  } else {
    toast('Saving to Photos is not supported here.');
  }
}

async function importFiles(files, part, brand) {
  const items = [];
  const blobs = [];
  for (const f of files) {
    const c = {
      id: uid(), createdAt: Date.now() + items.length, recordedAt: Date.now(), durationSec: null,
      mime: f.type || (part === 'REF' ? 'image/jpeg' : 'video/mp4'), size: f.size, camera: '',
      source: part === 'REF' ? 'ref' : 'import', origName: f.name || '', brand: brand || prefs.brand,
      part: part || prefs.part, note: '', status: part === 'REF' ? 'queued' : 'draft'
    };
    try {
      await blobStore.put(c.id, f);
      await clipsStore.put(c);
    } catch (e) {
      toast('Phone storage is full.', 4000);
      break;
    }
    items.push(c);
    blobs.push(f);
  }
  return { items, blobs };
}

/* ------------------------------------------------------------------ */
/* Upload status pill + Batch sheet                                    */
/* ------------------------------------------------------------------ */
async function refreshQueueUI() {
  let all = [];
  try { all = await clipsStore.all(); } catch (e) { return; }
  const pending = all.filter((c) => c.status !== 'done');
  const errors = pending.filter((c) => c.status === 'error');
  const active = all.find((c) => c.status === 'uploading');
  const q = $('queueBtn');
  q.classList.remove('warn', 'ok');
  if (!cfg.url) { q.textContent = 'Connect Drive'; q.classList.add('warn'); }
  else if (active) {
    const p = uploader.progressOf(active.id);
    q.textContent = `↑ ${pending.length} · ${p && p.total ? Math.floor((p.sent / p.total) * 100) : 0}%`;
  } else if (errors.length) { q.textContent = `⚠ ${errors.length} not sent`; q.classList.add('warn'); }
  else if (pending.length) q.textContent = `↑ ${pending.length} waiting`;
  else { q.textContent = '✓ Uploaded'; q.classList.add('ok'); }
  $('batchBadge').hidden = !pending.length;
  $('batchBadge').textContent = pending.length;
  if (openSheetId === 's-batch') renderBatchClips(all);
}

let batchBrand = prefs.brand;
const batchKey = (b) => `batch:${b}:${ptDayKey()}`;
const loadBatch = (b) => LS.get(batchKey(b), { instructions: '', references: [], ready: false, savedAt: null, dirty: false });

function persistBatchFields() {
  const b = loadBatch(batchBrand);
  const instr = $('batchInstr').value;
  const ready = $('batchReady').checked;
  if (instr !== b.instructions || ready !== b.ready) b.dirty = true;
  b.instructions = instr;
  b.ready = ready;
  LS.set(batchKey(batchBrand), b);
  return b;
}

async function openBatch() {
  batchBrand = prefs.brand;
  openSheet('s-batch');
  renderBatch();
}

async function renderBatch() {
  renderChips($('batchBrands'), allBrands(), batchBrand, (b) => { persistBatchFields(); batchBrand = b; renderBatch(); });
  $('batchDay').textContent = `${ptDayFolderName()} · Drive: Raw Clips / ${batchBrand} / ${ptDayFolderName()}`;
  const b = loadBatch(batchBrand);
  $('batchInstr').value = b.instructions;
  $('batchReady').checked = !!b.ready;
  renderRefs(b);
  $('batchStatus').textContent = b.savedAt
    ? `Last saved ${ptClock(new Date(b.savedAt))} PT${b.dirty ? ' · unsaved changes' : ''}`
    : (b.dirty ? 'Not saved yet' : '');
  renderBatchClips(await clipsStore.all());
}

function statusText(c) {
  const p = uploader.progressOf(c.id);
  switch (c.status) {
    case 'draft': return 'Not tagged yet, tap Tag';
    case 'queued': return cfg.url ? 'Waiting to upload' : 'Saved on phone, connect Drive in Settings';
    case 'uploading': return `Uploading ${p && p.total ? Math.floor((p.sent / p.total) * 100) : 0}% of ${fmtBytes(c.size)}`;
    case 'error': return 'Not sent: ' + (c.error || 'error') + (Number.isFinite(c.retryAt) ? ' (retrying)' : '');
    case 'done': return `In Drive ✓ ${c.folder || ''} · removed from phone`;
    default: return c.status;
  }
}

function renderBatchClips(all) {
  const today = ptDayKey();
  const list = all
    .filter((c) => c.brand === batchBrand && (c.status !== 'done' || ptDayKey(new Date(c.recordedAt)) === today))
    .sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
  const others = all.filter((c) => c.brand !== batchBrand && c.status !== 'done').length;
  const el = $('batchClips');
  if (!list.length) {
    el.innerHTML = `<p class="empty">No ${esc(batchBrand)} clips yet today.${others ? ` ${others} other clip(s) waiting in other brands.` : ''}</p>`;
    return;
  }
  el.innerHTML = list.map((c) => {
    const p = uploader.progressOf(c.id);
    const pct = c.status === 'done' ? 100 : p && p.total ? (p.sent / p.total) * 100 : 0;
    const name = c.fileName || clipName(c.part, c.brand, new Date(c.recordedAt), c.mime, c.origName);
    let action = '';
    if (c.status === 'draft') action = `<button data-act="tag" data-id="${c.id}">Tag</button>`;
    else if (c.status === 'error') action = `<button data-act="retry" data-id="${c.id}">Retry</button>`;
    else if (c.status === 'done' && c.link) action = `<a href="${esc(c.link)}" target="_blank" rel="noopener">Open</a>`;
    const del = c.status !== 'done' && c.status !== 'uploading' ? `<button data-act="del" data-id="${c.id}" aria-label="Delete">✕</button>` : '';
    return `<div class="clip"><span class="tag ${esc(c.part)}">${esc(c.part)}</span>
      <div class="meta"><b>${esc(name)}</b><small class="${c.status === 'error' ? 'err' : ''}">${esc(statusText(c))}${c.note ? ' · “' + esc(c.note) + '”' : ''}</small>
      ${c.status === 'uploading' ? `<div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>` : ''}</div>${action}${del}</div>`;
  }).join('') + (others ? `<p class="empty">${others} clip(s) from other brands still waiting.</p>` : '');
}

async function onBatchClipAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const c = await clipsStore.get(id);
  if (!c) return;
  if (btn.dataset.act === 'retry') { uploader.retry(id); toast('Retrying…'); }
  else if (btn.dataset.act === 'del') {
    if (!confirm('Delete this clip from the phone? It has not been uploaded.')) return;
    await blobStore.del(id).catch(() => {});
    await clipsStore.del(id);
    refreshQueueUI();
  } else if (btn.dataset.act === 'tag') {
    const blob = await blobStore.get(id);
    if (!blob) { toast('Video data is missing.'); return; }
    openReview([c], [blob]);
  }
}

function renderRefs(b) {
  $('refList').innerHTML = (b.references || []).map((r, i) =>
    `<li><span style="flex:1">${esc(r.url)}</span><button data-i="${i}" aria-label="Remove">✕</button></li>`).join('');
}

function addRef() {
  const url = $('refUrl').value.trim();
  if (!isHttpUrl(url)) { toast('Paste a full link starting with https://'); return; }
  const b = persistBatchFields();
  b.references = (b.references || []).concat([{ url, label: '' }]);
  b.dirty = true;
  LS.set(batchKey(batchBrand), b);
  $('refUrl').value = '';
  renderRefs(b);
  $('batchStatus').textContent = 'Unsaved changes';
}

async function saveBatch() {
  const b = persistBatchFields();
  if (!cfg.url) { $('batchStatus').textContent = 'Connect Drive in Settings first. Your notes are kept on this phone.'; return; }
  $('batchStatus').textContent = 'Saving…';
  try {
    const r = await uploader.saveBatch({ brand: batchBrand, date: ptDayKey(), instructions: b.instructions, references: b.references, ready: b.ready });
    b.savedAt = Date.now();
    b.dirty = false;
    LS.set(batchKey(batchBrand), b);
    $('batchStatus').textContent = `Saved to ${r.folder} / BATCH_NOTES.md at ${ptClock()} PT`;
  } catch (e) {
    $('batchStatus').textContent = 'Not saved: ' + e.message;
  }
}

/* ------------------------------------------------------------------ */
/* Tools: ring light, green screen, timer, grid, script               */
/* ------------------------------------------------------------------ */
function applyRing() {
  const r = prefs.ring;
  document.body.classList.toggle('ring-on', !!r.on);
  document.documentElement.style.setProperty('--ring-color', ringColor(r.warm, r.bright));
  document.documentElement.style.setProperty('--ring-size', r.size + 'vmin');
  $('ringBtn').classList.toggle('on', !!r.on);
  $('ringOn').checked = !!r.on;
  $('ringBright').value = r.bright;
  $('ringWarm').value = r.warm;
  $('ringSize').value = r.size;
}

async function setGs(mode, interactive = true) {
  if (mode === 'image' && !comp.bg && interactive) $('bgInput').click();
  prefs.gs = mode;
  savePrefs();
  document.querySelectorAll('#gsModes .chip').forEach((c) => c.classList.toggle('on', c.dataset.gs === mode));
  $('gsBtn').classList.toggle('on', mode !== 'off');
  fxCanvas.hidden = mode === 'off'; // the camera <video> keeps playing underneath; the canvas covers it
  if (mode !== 'off' && !comp.canRecord) $('gsStatus').textContent = 'Preview only: this browser cannot record effects.';
  await comp.setMode(mode);
}

async function setBackground(file) {
  await comp.setBackground(file);
  kv.set('bg', file).catch(() => {});
  renderBgThumb(file);
  if (prefs.gs === 'off' || prefs.gs === 'blur') setGs('image', false);
}

function renderBgThumb(file) {
  const el = $('bgThumb');
  el.innerHTML = '';
  if (!file) return;
  const url = URL.createObjectURL(file);
  const node = (file.type || '').startsWith('video/') ? Object.assign(document.createElement('video'), { muted: true, src: url }) : Object.assign(document.createElement('img'), { src: url });
  el.appendChild(node);
}

const TIMERS = [0, 3, 10];
function updateTimer() {
  $('timerLabel').textContent = prefs.countdown ? `${prefs.countdown}s` : 'Timer';
  $('timerBtn').classList.toggle('on', !!prefs.countdown);
}

function applyGrid() {
  $('grid').hidden = prefs.grid < 1;
  $('safe').hidden = prefs.grid < 2;
  $('gridLabel').textContent = prefs.grid === 2 ? 'Safe zone' : 'Grid';
  $('gridBtn').classList.toggle('on', prefs.grid > 0);
}

let prompterRAF = null;
let prompterY = 0;
let prompterPaused = false;
let prompterLast = 0;
function applyScript() {
  const s = prefs.script;
  $('prompter').hidden = !(s.on && s.text.trim());
  $('prompterText').textContent = s.text;
  $('prompterText').style.fontSize = s.size + 'px';
  $('scriptBtn').classList.toggle('on', !!(s.on && s.text.trim()));
  $('scriptOn').checked = !!s.on;
  $('scriptSpeed').value = s.speed;
  $('scriptSize').value = s.size;
  if (document.activeElement !== $('scriptText')) $('scriptText').value = s.text;
}
function setPrompterY() { $('prompterText').style.transform = `translateY(${-prompterY}px)`; }
function startPrompter() {
  if ($('prompter').hidden) return;
  prompterY = 0;
  prompterPaused = false;
  prompterLast = performance.now();
  setPrompterY();
  cancelAnimationFrame(prompterRAF);
  prompterRAF = requestAnimationFrame(stepPrompter);
}
function stepPrompter(t) {
  const dt = Math.min(0.1, (t - prompterLast) / 1000);
  prompterLast = t;
  if (!prompterPaused) {
    const max = Math.max(0, $('prompterText').scrollHeight - $('prompter').clientHeight * 0.5);
    prompterY = Math.min(max, prompterY + prefs.script.speed * dt);
    setPrompterY();
  }
  prompterRAF = requestAnimationFrame(stepPrompter);
}
function stopPrompter() { cancelAnimationFrame(prompterRAF); prompterRAF = null; }

/* ------------------------------------------------------------------ */
/* Top bar + settings                                                  */
/* ------------------------------------------------------------------ */
function renderTop() {
  $('brandBtn').textContent = prefs.brand + ' ▾';
  document.querySelectorAll('#partSeg button').forEach((b) => b.classList.toggle('on', b.dataset.part === prefs.part));
}

function openBrandSheet() {
  renderChips($('brandList'), allBrands(), prefs.brand, (b) => {
    prefs.brand = b;
    savePrefs();
    renderTop();
    closeSheet();
  });
  openSheet('s-brand');
}

async function openSettings() {
  $('cfgUrl').value = cfg.url || '';
  $('cfgKey').value = cfg.key || '';
  $('cfgLink').value = '';
  $('quality').value = prefs.quality;
  $('maxLen').value = String(prefs.maxLen);
  $('versionInfo').textContent = `Grok Film ${APP_VERSION}${isStandalone ? ' · installed' : ' · in browser'}`;
  setConn(cfg.url ? 'Connected (tap Save & test to check).' : 'Not connected yet. Paste the setup link from Grok Bot.', cfg.url ? '' : 'bad');
  updateCamInfo();
  openSheet('s-settings');
  try {
    const all = await clipsStore.all();
    const waiting = all.filter((c) => c.status !== 'done');
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    $('storageInfo').textContent = `${waiting.length} clip(s) on this phone waiting to upload (${fmtBytes(waiting.reduce((n, c) => n + (c.size || 0), 0))}).` +
      (est ? ` App storage used: ${fmtBytes(est.usage)}.` : '') + ' Uploaded clips are removed from the phone automatically.';
  } catch (e) { /* ignore */ }
}

async function saveSettings() {
  const link = $('cfgLink').value.trim();
  if (link) {
    const m = /setup=([^&\s]+)/.exec(link);
    const s = m && decodeSetup(decodeURIComponent(m[1]));
    if (!s) { setConn('That is not a setup link. It should contain "#setup=".', 'bad'); return; }
    cfg = s;
  } else {
    cfg = { url: $('cfgUrl').value.trim(), key: $('cfgKey').value.trim() };
  }
  LS.set('cfg', cfg);
  $('cfgLink').value = '';
  $('cfgUrl').value = cfg.url;
  $('cfgKey').value = cfg.key;
  await testConn();
}

async function pruneOld() {
  const cutoff = Date.now() - 3 * 864e5;
  for (const c of await clipsStore.all()) {
    if (c.status === 'done' && (c.doneAt || 0) < cutoff) await clipsStore.del(c.id);
  }
}

/* ------------------------------------------------------------------ */
/* Wire up                                                             */
/* ------------------------------------------------------------------ */
function bind() {
  $('recBtn').onclick = onRecButton;
  $('flipBtn').onclick = () => {
    if (recording) return;
    prefs.facing = prefs.facing === 'user' ? 'environment' : 'user';
    prefs.lensId = '';
    savePrefs();
    startCamera();
  };
  $('lensBtn').onclick = () => {
    if (recording || lenses.length < 2) return;
    const i = lenses.findIndex((l) => l.id === prefs.lensId);
    const cur = i >= 0 ? i : lenses.findIndex((l) => l.label === '1x');
    const next = lenses[(cur + 1) % lenses.length];
    prefs.lensId = next.id;
    savePrefs();
    startCamera();
  };

  $('ringBtn').onclick = () => {
    const opened = togglePanel('ringBtn');
    if (opened && !prefs.ring.on) { prefs.ring.on = true; savePrefs(); applyRing(); }
  };
  $('ringOn').onchange = (e) => { prefs.ring.on = e.target.checked; savePrefs(); applyRing(); };
  ['ringBright', 'ringWarm', 'ringSize'].forEach((id) => {
    $(id).oninput = (e) => {
      const key = { ringBright: 'bright', ringWarm: 'warm', ringSize: 'size' }[id];
      prefs.ring[key] = Number(e.target.value);
      prefs.ring.on = true;
      savePrefs();
      applyRing();
    };
  });

  $('gsBtn').onclick = () => togglePanel('gsBtn');
  $('gsModes').onclick = (e) => { const b = e.target.closest('[data-gs]'); if (b) setGs(b.dataset.gs); };
  $('bgInput').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await setBackground(f);
  };

  $('timerBtn').onclick = () => {
    prefs.countdown = TIMERS[(TIMERS.indexOf(prefs.countdown) + 1) % TIMERS.length];
    savePrefs();
    updateTimer();
    toast(prefs.countdown ? `${prefs.countdown}s countdown before recording` : 'Countdown off', 1400);
  };
  $('gridBtn').onclick = () => {
    prefs.grid = (prefs.grid + 1) % 3;
    savePrefs();
    applyGrid();
    toast(['Grid off', 'Grid on', 'Grid + TikTok safe zones'][prefs.grid], 1400);
  };

  $('scriptBtn').onclick = () => togglePanel('scriptBtn');
  $('scriptText').oninput = (e) => { prefs.script.text = e.target.value; if (e.target.value.trim()) prefs.script.on = true; savePrefs(); applyScript(); };
  $('scriptOn').onchange = (e) => { prefs.script.on = e.target.checked; savePrefs(); applyScript(); };
  $('scriptSpeed').oninput = (e) => { prefs.script.speed = Number(e.target.value); savePrefs(); };
  $('scriptSize').oninput = (e) => { prefs.script.size = Number(e.target.value); savePrefs(); applyScript(); };
  $('prompter').onclick = () => { if (!prompterRAF) startPrompter(); else prompterPaused = !prompterPaused; };

  $('stage').addEventListener('click', closePanels);
  $('settingsBtn').onclick = openSettings;
  $('brandBtn').onclick = openBrandSheet;
  $('partSeg').onclick = (e) => {
    const b = e.target.closest('[data-part]');
    if (!b) return;
    prefs.part = b.dataset.part;
    savePrefs();
    renderTop();
  };
  $('queueBtn').onclick = () => (cfg.url ? openBatch() : openSettings());
  $('batchBtn').onclick = openBatch;

  $('importInput').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const { items, blobs } = await importFiles(files);
    if (items.length) openReview(items, blobs);
  };

  $('backdrop').onclick = closeSheet;
  document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeSheet; });
  $('saveBtn').onclick = saveReview;
  $('retakeBtn').onclick = () => discardReview(false);
  $('photosBtn').onclick = saveToPhotos;

  $('addBrand').onclick = () => {
    const name = $('newBrand').value.trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._&-]{0,39}$/.test(name)) { toast('Use letters and numbers only.'); return; }
    if (!allBrands().includes(name)) prefs.brands = (prefs.brands || []).concat([name]);
    prefs.brand = name;
    savePrefs();
    renderTop();
    $('newBrand').value = '';
    closeSheet();
  };

  $('batchClips').onclick = onBatchClipAction;
  $('refAdd').onclick = addRef;
  $('refUrl').onkeydown = (e) => { if (e.key === 'Enter') addRef(); };
  $('refList').onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const st = persistBatchFields();
    st.references.splice(Number(b.dataset.i), 1);
    st.dirty = true;
    LS.set(batchKey(batchBrand), st);
    renderRefs(st);
    $('batchStatus').textContent = 'Unsaved changes';
  };
  $('refFiles').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const { items } = await importFiles(files, 'REF', batchBrand);
    toast(`${items.length} reference file(s) queued for ${batchBrand}`);
    refreshQueueUI();
    uploader.run();
  };
  $('batchInstr').oninput = () => { $('batchStatus').textContent = 'Unsaved changes'; };
  $('batchReady').onchange = () => { persistBatchFields(); saveBatch(); };
  $('batchSave').onclick = saveBatch;

  $('cfgSave').onclick = saveSettings;
  $('pasteLink').onclick = async () => {
    try { $('cfgLink').value = await navigator.clipboard.readText(); } catch (e) { toast('Long-press the box and tap Paste.'); }
  };
  $('quality').onchange = (e) => { prefs.quality = e.target.value; savePrefs(); startCamera(); };
  $('maxLen').onchange = (e) => { prefs.maxLen = Number(e.target.value); savePrefs(); };
  $('retryAll').onclick = () => { uploader.retryAll(); toast('Retrying failed uploads…'); };
  $('clearDone').onclick = async () => {
    for (const c of await clipsStore.all()) if (c.status === 'done') await clipsStore.del(c.id);
    refreshQueueUI();
    toast('Cleared');
  };
  $('tipClose').onclick = () => { $('installTip').hidden = true; LS.set('tipDone', true); };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (recording) stopRecording();
      return;
    }
    if (!streamLive() && !recording) startCamera();
    wake(true);
    uploader.run();
  });
  window.addEventListener('online', () => uploader.run());
  window.addEventListener('hashchange', () => { consumeSetupHash(); refreshQueueUI(); });
  setInterval(() => { if (!document.hidden) uploader.run(); }, 30000);
}

async function init() {
  consumeSetupHash();
  bind();
  renderTop();
  applyRing();
  applyScript();
  applyGrid();
  updateTimer();
  comp.onStatus = (m) => { $('gsStatus').textContent = m; if (m) toast(m, 3500); };
  try {
    const bg = await kv.get('bg');
    if (bg) { await comp.setBackground(bg); renderBgThumb(bg); }
  } catch (e) { /* no saved background */ }
  await startCamera();
  if (prefs.gs !== 'off') setGs(prefs.gs, false);
  try { await pruneOld(); } catch (e) { /* ignore */ }
  refreshQueueUI();
  uploader.run();
  if (!cfg.url) setTimeout(() => toast('Tap "Connect Drive" (top right) to link uploads.', 3500), 1200);
  if (isIOS && !isStandalone && !LS.get('tipDone', false)) $('installTip').hidden = false;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();

import {
  BRANDS, PARTS, PART_LABELS, APP_VERSION, DEFAULT_EV, ptDayKey, ptClock, clipName, pickMimeType,
  decodeSetup, fmtDur, fmtBytes, ringColor, uid, dailyTarget, dayKeyToFolderName, shiftDayKey, dayKeyLabel,
  videoNumbers, mergeVideo, pendingForVideo, extractUrls, refLabel, qualityOf, videoConstraints, resLabel,
  exposureSupport, clampEv, evFromDrag, evToDarkAlpha, fmtEv, orderParts, isDayKey, ptTimeToken
} from './shared.js';
import {
  newTake, takeTotal, addSegment, removeLastSegment, deleteTap, DELETE_CONFIRM_MS, POST_ROLL_MS, barScale, barLayout, fmtTake,
  segmentClipPlan, mergeSegNote, userPartOfNote, pruneMissing
} from './segments.js';
import { joinFmp4, fmp4Duration } from './mp4join.js';
import { clipsStore, blobStore, kv, recParts } from './store.js';
import { createUploader } from './uploader.js';
import { Compositor } from './effects.js';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('gf.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('gf.' + k, JSON.stringify(v)); } catch (e) { /* storage full / private */ } },
  del(k) { try { localStorage.removeItem('gf.' + k); } catch (e) { /* ignore */ } },
  keys(prefix) { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('gf.' + prefix)) out.push(k.slice(3)); } } catch (e) { /* ignore */ } return out; }
};
const DEFAULTS = {
  part: 'HOOK', facing: 'user', lensId: '',
  ring: { on: false, bright: 100, warm: 50, size: 12 },
  gs: 'off', countdown: 0, grid: 0,
  script: { on: false, text: '', speed: 35, size: 28 },
  quality: '1080', maxLen: 0, brands: [],
  ev: Object.assign({}, DEFAULT_EV), darken: false, chunked: true
};
const stored = LS.get('prefs', {});
const prefs = Object.assign({}, DEFAULTS, stored, {
  ring: Object.assign({}, DEFAULTS.ring, stored.ring),
  script: Object.assign({}, DEFAULTS.script, stored.script),
  ev: Object.assign({}, DEFAULT_EV, stored.ev)
});
if (!PARTS.includes(prefs.part)) prefs.part = 'HOOK';
const savePrefs = () => LS.set('prefs', prefs);
let cfg = LS.get('cfg', { url: '', key: '' });
const allBrands = () => {
  const extra = (prefs.brands || []).filter((b) => !BRANDS.includes(b));
  return BRANDS.slice().sort((a, b) => dailyTarget(b) - dailyTarget(a) || BRANDS.indexOf(a) - BRANDS.indexOf(b)).concat(extra);
};
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Where we are: home (brands) -> brand (Video 1..N) -> video (one folder) -> camera (filming into that folder)
const nav = { view: 'home', day: ptDayKey(), brand: null, video: null };

const video = $('cam');
const fxCanvas = $('fx');
const comp = new Compositor(video, fxCanvas);
let stream = null;
let lenses = [];
let camActual = { w: 0, h: 0, fps: 0 };
let allClips = [];

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
  if (openSheetId && openSheetId !== id) $(openSheetId).hidden = true;
  openSheetId = id;
  $(id).hidden = false;
  $('backdrop').hidden = false;
}
function closeSheet() {
  if (!openSheetId) return;
  const id = openSheetId;
  if (id === 's-review') { discardReview(true); return; }
  $(id).hidden = true;
  $('backdrop').hidden = true;
  openSheetId = null;
}

const PANELS = { ringBtn: 'p-ring', gsBtn: 'p-gs', scriptBtn: 'p-script', evBtn: 'p-ev' };
function closePanels() { Object.values(PANELS).forEach((p) => { $(p).hidden = true; }); }
function togglePanel(btnId) {
  const id = PANELS[btnId];
  const wasOpen = !$(id).hidden;
  closePanels();
  if (!wasOpen) $(id).hidden = false;
  return !wasOpen;
}

function renderChips(el, items, current, onPick, cls = '') {
  el.innerHTML = items.map((v) => {
    const val = typeof v === 'object' ? v.v : v;
    const label = typeof v === 'object' ? v.label : v;
    return `<button class="chip ${cls} ${String(val) === String(current) ? 'on' : ''}" data-v="${esc(val)}">${esc(label)}</button>`;
  }).join('');
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
    const old = !r.version || r.version < '0.2.0';
    setConn(`Connected ✓ Saving to "${r.root}". Today's folder: ${r.today}` +
      (old ? ` · The receiver is version ${r.version || '0.1'}; update it so folders sync (ask Grok Bot).` : '') +
      (r.notify === false && !old ? ' · Editor notifications: Drive queue file only (no webhook set).' : ''), old ? 'bad' : 'ok');
    uploader.retryAll();
    if (nav.brand) syncDay(nav.brand, nav.day);
  } catch (e) {
    setConn(e.message, 'bad');
  }
  refreshQueueUI();
}

/* ------------------------------------------------------------------ */
/* Folder state (synced with Drive through the receiver)               */
/* ------------------------------------------------------------------ */
const fkey = (brand, day) => `fold:${brand}:${day}`;
function dayState(brand, day) {
  const st = LS.get(fkey(brand, day), null) || { count: dailyTarget(brand), videos: {}, fetchedAt: 0, error: '' };
  for (const k of Object.keys(st.videos)) st.videos[k] = mergeVideo(st.videos[k], null);
  return st;
}
function putDay(brand, day, st) { LS.set(fkey(brand, day), st); }
function vget(st, k) { return st.videos[k] || (st.videos[k] = mergeVideo(null, null)); }
function videoNums(st) { return videoNumbers(st.count, Object.keys(st.videos).map(Number)); }

const syncing = new Map();
function syncDay(brand, day) {
  if (!cfg.url) return Promise.resolve();
  const key = fkey(brand, day);
  if (syncing.has(key)) return syncing.get(key);
  const p = (async () => {
    try {
      const r = await uploader.getDay(brand, day);
      const st = dayState(brand, day);
      for (const sv of r.videos || []) st.videos[sv.video] = mergeVideo(st.videos[sv.video], sv);
      st.fetchedAt = Date.now();
      st.error = '';
      putDay(brand, day, st);
      for (const [num, v] of Object.entries(st.videos)) if (v.dirty) schedulePush(brand, day, Number(num), 10);
    } catch (e) {
      const st = dayState(brand, day);
      st.error = e.code === 'unknown_action' ? 'The Drive receiver needs updating to sync folders (ask Grok Bot).' : e.message;
      putDay(brand, day, st);
    } finally {
      syncing.delete(key);
    }
    renderBrowser();
  })();
  syncing.set(key, p);
  return p;
}

const pushTimers = new Map();
function schedulePush(brand, day, k, ms = 900) {
  const key = `${brand}|${day}|${k}`;
  clearTimeout(pushTimers.get(key));
  pushTimers.set(key, setTimeout(() => { pushTimers.delete(key); pushVideo(brand, day, k); }, ms));
}

async function pushVideo(brand, day, k) {
  if (!cfg.url) return;
  const v = vget(dayState(brand, day), k);
  const sent = JSON.stringify([v.notes, v.refLinks]);
  try {
    const r = await uploader.saveVideo({ brand, date: day, video: k, refLinks: v.refLinks, notes: v.notes });
    const st = dayState(brand, day);
    const cur = vget(st, k);
    if (JSON.stringify([cur.notes, cur.refLinks]) === sent) cur.dirty = false;
    cur.syncError = '';
    st.videos[k] = mergeVideo(cur, r.video);
    st.fetchedAt = Date.now();
    putDay(brand, day, st);
  } catch (e) {
    const st = dayState(brand, day);
    vget(st, k).syncError = e.code === 'unknown_action' ? 'The Drive receiver needs updating to sync folders.' : e.message;
    putDay(brand, day, st);
  }
  renderBrowser();
}

function editVideo(fn) {
  const { brand, day, video: k } = nav;
  const st = dayState(brand, day);
  const v = vget(st, k);
  fn(v);
  v.dirty = true;
  putDay(brand, day, st);
  schedulePush(brand, day, k);
  renderBrowser();
}

function pruneDayStates() {
  const cutoff = shiftDayKey(ptDayKey(), -10);
  for (const k of LS.keys('fold:')) {
    const day = k.split(':').pop();
    if (isDayKey(day) && day < cutoff) LS.del(k);
  }
}

/* ---------- DONE: upload what's pending, then mark ready + notify the editor ---------- */
async function onDone() {
  const { brand, day, video: k } = nav;
  if (!cfg.url) { toast('Connect Drive in Settings first.'); openSettings(); return; }
  const st = dayState(brand, day);
  const v = vget(st, k);
  if ($('vNotes').value !== v.notes) { v.notes = $('vNotes').value; v.dirty = true; }
  const pend = pendingForVideo(allClips, brand, day, k);
  const known = v.clips.filter((c) => c.part !== 'REF').length + (v.files || []).length;
  if (!known && !pend.length && !confirm(`Video ${k} has no clips yet. Send it to the editor anyway?`)) return;
  for (const c of pend) {
    if (c.status === 'draft' || c.status === 'error') { c.status = 'queued'; c.retryAt = 0; c.tries = 0; await clipsStore.put(c); }
  }
  v.doneRequested = true;
  v.doneError = '';
  v.doneRetryAt = 0;
  putDay(brand, day, st);
  toast(pend.length ? `Uploading ${pend.length} clip(s), then the editor gets Video ${k}…` : `Sending Video ${k} to the editor…`, 3200);
  await refreshQueueUI();
  uploader.run();
}

const doneBusy = new Set();
async function checkDone() {
  if (!cfg.url) return;
  for (const key of LS.keys('fold:')) {
    const [, brand, day] = key.split(':');
    const st = LS.get(key, null);
    if (!st || !st.videos) continue;
    for (const [num, v] of Object.entries(st.videos)) {
      if (!v.doneRequested) continue;
      const k = Number(num);
      const id = `${brand}|${day}|${k}`;
      if (doneBusy.has(id) || (v.doneRetryAt || 0) > Date.now()) continue;
      const pend = pendingForVideo(allClips, brand, day, k);
      const stuck = pend.filter((c) => c.status === 'error' && !Number.isFinite(c.retryAt));
      if (stuck.length) {
        const st2 = dayState(brand, day);
        vget(st2, k).doneError = `${stuck.length} clip(s) didn't upload: ${stuck[0].error || 'error'}. Fix that and the video is sent automatically.`;
        putDay(brand, day, st2);
        continue;
      }
      if (pend.length) continue;
      doneBusy.add(id);
      try {
        const r = await uploader.markDone({ brand, date: day, video: k, refLinks: v.refLinks, notes: v.notes });
        const st2 = dayState(brand, day);
        const cur = vget(st2, k);
        Object.assign(cur, { doneRequested: false, doneError: '', dirty: false, lastNotify: { notified: !!r.notified, skipped: !!r.notifySkipped, queued: !!r.queued } });
        st2.videos[k] = mergeVideo(cur, r.video);
        putDay(brand, day, st2);
        toast(`${brand} Video ${k} sent to the editor ✓`, 3500);
      } catch (e) {
        const st2 = dayState(brand, day);
        const cur = vget(st2, k);
        cur.doneError = 'Not sent yet: ' + (e.code === 'unknown_action' ? 'the Drive receiver needs updating.' : e.message) + ' Retrying…';
        cur.doneRetryAt = Date.now() + 30000;
        putDay(brand, day, st2);
      } finally {
        doneBusy.delete(id);
      }
      renderBrowser();
    }
  }
}

async function onReopen() {
  const { brand, day, video: k } = nav;
  if (!confirm(`Mark Video ${k} as still filming? The editor already got a ping; tell it if it should stop.`)) return;
  try {
    const r = await uploader.saveVideo({ brand, date: day, video: k, ready: false });
    const st = dayState(brand, day);
    st.videos[k] = mergeVideo(vget(st, k), r.video);
    putDay(brand, day, st);
  } catch (e) { toast('Not changed: ' + e.message); }
  renderBrowser();
}

/* ------------------------------------------------------------------ */
/* Folders UI: home -> brand -> video                                  */
/* ------------------------------------------------------------------ */
function go(view, patch = {}) {
  Object.assign(nav, patch, { view });
  if (view === 'camera') { enterCamera(); return; }
  showBrowser();
  renderBrowser();
  const sc = $('browser');
  sc.scrollTop = 0;
  if ((view === 'brand' || view === 'video') && nav.brand) syncDay(nav.brand, nav.day);
}

function showBrowser() {
  $('browser').hidden = false;
  document.body.classList.remove('cam');
  closePanels();
}

function dayWord(day) {
  const today = ptDayKey();
  if (day === today) return 'Today';
  if (day === shiftDayKey(today, 1)) return 'Tomorrow';
  if (day === shiftDayKey(today, -1)) return 'Yesterday';
  return '';
}

function localFor(brand, day, k) {
  return allClips.filter((c) => c.brand === brand && c.day === day && (k == null || Number(c.video) === Number(k)));
}

function renderBrowser() {
  if (nav.view === 'camera') { renderCamTop(); return; }
  $('vHome').hidden = nav.view !== 'home';
  $('vBrand').hidden = nav.view !== 'brand';
  $('vVideo').hidden = nav.view !== 'video';
  $('bBack').hidden = nav.view === 'home';
  if (nav.view === 'home') renderHome();
  else if (nav.view === 'brand') renderBrand();
  else if (nav.view === 'video') renderVideo();
}

function renderHome() {
  $('bTitle').textContent = 'Grok Film';
  $('bSub').textContent = cfg.url ? 'Pick a brand, then a video folder.' : 'Not connected to Drive yet. Tap Set up (top right).';
  const w = dayWord(nav.day);
  $('dayLabel').textContent = (w ? w + ' · ' : '') + dayKeyLabel(nav.day);
  $('brandList').innerHTML = allBrands().map((b) => {
    const st = dayState(b, nav.day);
    const nums = videoNums(st);
    const ready = nums.filter((k) => st.videos[k] && st.videos[k].ready).length;
    const waiting = localFor(b, nav.day).filter((c) => c.status !== 'done').length;
    const t = dailyTarget(b);
    const bits = [`${nums.length} video${nums.length === 1 ? '' : 's'}`];
    if (ready) bits.push(`${ready} sent ✓`);
    if (waiting) bits.push(`${waiting} uploading`);
    return `<button class="card" data-brand="${esc(b)}"><span class="card-main"><b>${esc(b)}</b><small>${esc(bits.join(' · '))}</small></span>
      <span class="card-side">${t ? t + '/day' : 'paused'}</span></button>`;
  }).join('');
}

function renderBrand() {
  const { brand, day } = nav;
  const st = dayState(brand, day);
  $('bTitle').textContent = brand;
  const t = dailyTarget(brand);
  $('bSub').textContent = `${dayWord(day) ? dayWord(day) + ' · ' : ''}${dayKeyLabel(day)} · target ${t}/day`;
  const nums = videoNums(st);
  $('videoList').innerHTML = nums.length ? nums.map((k) => {
    const v = st.videos[k] || mergeVideo(null, null);
    const local = localFor(brand, day, k);
    const waiting = local.filter((c) => c.status !== 'done' && c.part !== 'REF').length;
    const inDrive = Math.max(v.clips.filter((c) => c.part !== 'REF').length, (v.files || []).filter((f) => /^video\//.test(f.mimeType || '')).length);
    const bits = [];
    bits.push(`${inDrive + waiting} clip${inDrive + waiting === 1 ? '' : 's'}`);
    if (waiting) bits.push(`${waiting} uploading`);
    if (v.refLinks.length) bits.push(`${v.refLinks.length} ref${v.refLinks.length === 1 ? '' : 's'}`);
    if (v.notes) bits.push('notes');
    const status = v.ready ? '<span class="st ok">Sent ✓</span>' : v.doneRequested ? '<span class="st">Sending…</span>' : '';
    return `<button class="card" data-video="${k}"><span class="card-main"><b>Video ${k}</b><small>${esc(bits.join(' · '))}</small></span>${status}<span class="chev">›</span></button>`;
  }).join('') : '<p class="empty">No videos planned for this brand today. Tap “Add video”.</p>';
  $('brandSync').textContent = !cfg.url ? 'Saved on this device only. Connect Drive in Settings to sync with your other devices.'
    : st.error ? 'Sync problem: ' + st.error
    : st.fetchedAt ? `Synced with Drive at ${ptClock(new Date(st.fetchedAt))} PT` : 'Syncing…';
}

function clipRow(c, withPlace = false) {
  const p = uploader.progressOf(c.id);
  const pct = c.status === 'done' ? 100 : p && p.total ? (p.sent / p.total) * 100 : 0;
  const name = c.fileName || clipName(c.part, c.brand, new Date(c.recordedAt), c.mime, c.origName, c.video);
  let action = '';
  if (c.status === 'draft') action = `<button data-act="tag" data-id="${c.id}">Tag</button>`;
  else if (c.status === 'error') action = `<button data-act="retry" data-id="${c.id}">Retry</button>`;
  else if (c.status === 'done' && c.link) action = `<a href="${esc(c.link)}" target="_blank" rel="noopener">Open</a>`;
  const del = c.status !== 'done' && c.status !== 'uploading' ? `<button data-act="del" data-id="${c.id}" aria-label="Delete">✕</button>` : '';
  const place = withPlace ? `${c.brand}${c.video ? ' · Video ' + c.video : ''} · ` : '';
  return `<div class="clip"><span class="tag ${esc(c.part)}">${esc(PART_LABELS[c.part] || c.part)}</span>
    <div class="meta"><b>${esc(name)}</b><small class="${c.status === 'error' ? 'err' : ''}">${esc(place + statusText(c))}${c.note ? ' · “' + esc(c.note) + '”' : ''}</small>
    ${c.status === 'uploading' ? `<div class="bar"><i style="width:${pct.toFixed(0)}%"></i></div>` : ''}</div>${action}${del}</div>`;
}

function driveRow(file, part, extra, id) {
  return `<div class="clip"><span class="tag ${esc(part)}">${esc(PART_LABELS[part] || part)}</span>
    <div class="meta"><b>${esc(file)}</b><small>${esc(extra)}</small></div>
    ${id ? `<a href="https://drive.google.com/file/d/${esc(id)}/view" target="_blank" rel="noopener">Open</a>` : ''}</div>`;
}

function renderVideo() {
  const { brand, day, video: k } = nav;
  const st = dayState(brand, day);
  const v = vget(st, k);
  $('bTitle').textContent = `Video ${k}`;
  $('bSub').innerHTML = `<b>${esc(brand)}</b> · ${esc((dayWord(day) ? dayWord(day) + ' · ' : '') + dayKeyLabel(day))} · ` +
    (v.folderUrl ? `<a href="${esc(v.folderUrl)}" target="_blank" rel="noopener">Open in Drive</a>` : esc(`Drive: ${brand} / ${dayKeyToFolderName(day)} / Video ${k}`));

  // ready / sending banner
  const box = $('vReadyBox');
  if (v.doneRequested) {
    const left = pendingForVideo(allClips, brand, day, k).length;
    box.className = 'readybox' + (v.doneError ? ' bad' : '');
    box.textContent = v.doneError || (left ? `Uploading ${left} clip(s). The editor gets this video as soon as they're in Drive. Keep the app open.` : 'Sending to the editor…');
    box.hidden = false;
  } else if (v.ready) {
    box.className = 'readybox ok';
    const how = v.lastNotify ? (v.lastNotify.notified ? ' Editor notified.' : v.lastNotify.queued ? ' Added to the editor queue in Drive.' : '') : '';
    box.textContent = `✓ Sent to the editor${v.readyAt ? ' at ' + ptClock(new Date(v.readyAt)) + ' PT' : ''}.${how}`;
    box.hidden = false;
  } else box.hidden = true;

  // clips: on this device (not yet in Drive) + in Drive (from the folder manifest / file list)
  const local = localFor(brand, day, k).sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
  const serverIds = new Set(v.clips.map((c) => c.fileId));
  const rows = [];
  for (const c of local) if (!(c.status === 'done' && serverIds.has(c.fileId))) rows.push(clipRow(c));
  const order = { HOOK: 0, INSERT: 1, DEMO: 2, CTA: 3, REF: 9 };
  v.clips.slice().sort((a, b) => (order[a.part] ?? 5) - (order[b.part] ?? 5) || String(a.recordedAt).localeCompare(String(b.recordedAt)))
    .forEach((c) => rows.push(driveRow(c.file, c.part, `In Drive ✓${c.durationSec ? ' · ' + fmtDur(c.durationSec) : ''}${c.note ? ' · “' + c.note + '”' : ''}`, c.fileId)));
  const known = new Set(v.clips.map((c) => c.fileId));
  (v.files || []).filter((f) => !known.has(f.id)).forEach((f) => rows.push(driveRow(f.name, 'FILE', 'In Drive (added outside the app)', f.id)));
  $('vClips').innerHTML = rows.join('') || '<p class="empty">No clips yet. Tap Film, or add from your camera roll.</p>';

  // reference links
  $('vRefList').innerHTML = v.refLinks.map((r, i) =>
    `<li><span class="rl">${esc(r.label || refLabel(r.url))}</span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a><button data-i="${i}" aria-label="Remove">✕</button></li>`).join('') ||
    '<li class="empty">No reference links yet.</li>';

  if (document.activeElement !== $('vNotes')) $('vNotes').value = v.notes;
  $('vSync').textContent = !cfg.url ? 'Saved on this device only. Connect Drive in Settings to sync.'
    : v.syncError ? 'Not synced: ' + v.syncError
    : v.dirty ? 'Saving to Drive…'
    : st.fetchedAt ? `Synced with Drive · ${ptClock(new Date(st.fetchedAt))} PT` : 'Syncing…';
  $('vDone').textContent = v.ready ? 'Send to editor again' : 'Done · send to editor';
  $('vDone').disabled = !!v.doneRequested;
  $('vReopen').hidden = !v.ready || !!v.doneRequested;
  $('filmBtn').hidden = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const mine = take && take.segs.length && take.brand === brand && take.day === day && Number(take.video) === Number(k);
  $('filmBtn').textContent = mine ? `● Continue take (${take.segs.length} part${take.segs.length > 1 ? 's' : ''} · ${fmtTake(takeTotal(take))})` : '● Film';
}

function addRefsFromInput() {
  const urls = extractUrls($('vRefUrl').value);
  if (!urls.length) { toast('Paste a full link starting with https://'); return; }
  editVideo((v) => {
    const have = new Set(v.refLinks.map((r) => r.url));
    v.refLinks = v.refLinks.concat(urls.filter((u) => !have.has(u)).map((url) => ({ url, label: refLabel(url) }))).slice(0, 50);
  });
  $('vRefUrl').value = '';
  toast(urls.length > 1 ? `${urls.length} links added` : 'Link added', 1400);
}

function addVideo() {
  const { brand, day } = nav;
  const st = dayState(brand, day);
  const n = videoNums(st).length + 1;
  if (n > 50) { toast('That is a lot of videos. 50 is the max.'); return; }
  st.count = n;
  const v = vget(st, n);
  v.dirty = true; // creates "Video N" in Drive on the next save
  putDay(brand, day, st);
  schedulePush(brand, day, n, 10);
  go('video', { video: n });
}

/* Uploads sheet (every clip still on this device) */
function statusText(c) {
  const p = uploader.progressOf(c.id);
  switch (c.status) {
    case 'draft': return 'Not tagged yet, tap Tag';
    case 'queued': return cfg.url ? 'Waiting to upload' : 'Saved on this device, connect Drive in Settings';
    case 'uploading': return `Uploading ${p && p.total ? Math.floor((p.sent / p.total) * 100) : 0}% of ${fmtBytes(c.size)}`;
    case 'error': return 'Not sent: ' + (c.error || 'error') + (Number.isFinite(c.retryAt) ? ' (retrying)' : '');
    case 'done': return `In Drive ✓ · removed from phone`;
    default: return c.status;
  }
}

function openUploads() { openSheet('s-uploads'); renderUploads(); }
function renderUploads() {
  const today = ptDayKey();
  const list = allClips.filter((c) => c.status !== 'done' || ptDayKey(new Date(c.doneAt || c.recordedAt)) === today)
    .sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
  $('upClips').innerHTML = list.length ? list.map((c) => clipRow(c, true)).join('') : '<p class="empty">Nothing waiting. Everything is in Drive.</p>';
}

async function onClipAction(e) {
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

async function refreshQueueUI() {
  try { allClips = await clipsStore.all(); } catch (e) { return; }
  const pending = allClips.filter((c) => c.status !== 'done');
  const errors = pending.filter((c) => c.status === 'error');
  const active = allClips.find((c) => c.status === 'uploading');
  let text, cls = '';
  if (!cfg.url) { text = 'Set up'; cls = 'warn'; }
  else if (active) {
    const p = uploader.progressOf(active.id);
    text = `↑ ${pending.length} · ${p && p.total ? Math.floor((p.sent / p.total) * 100) : 0}%`;
  } else if (errors.length) { text = `⚠ ${errors.length} not sent`; cls = 'warn'; }
  else if (pending.length) text = `↑ ${pending.length} waiting`;
  else { text = '✓ Uploaded'; cls = 'ok'; }
  for (const id of ['queueBtn', 'bQueue']) {
    const q = $(id);
    q.textContent = text;
    q.classList.remove('warn', 'ok');
    if (cls) q.classList.add(cls);
  }
  const here = nav.video ? pendingForVideo(allClips, nav.brand, nav.day, nav.video).length : 0;
  $('folderBadge').hidden = !here;
  $('folderBadge').textContent = here;
  if (openSheetId === 's-uploads') renderUploads();
  if (nav.view !== 'camera') renderBrowser();
  checkDone();
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */
let camIdleTimer = null;
function enterCamera() {
  if (!nav.brand || !nav.video) { go('home'); return; }
  nav.view = 'camera';
  $('browser').hidden = true;
  document.body.classList.add('cam');
  clearTimeout(camIdleTimer);
  renderCamTop();
  refreshQueueUI();
  renderTakeUI();
  if (!camReady()) startCamera(); else applyEv(true);
  if (take && take.segs.length && !takeHere()) {
    // only one take at a time: an unfinished take from another video gets finished (review sheet) first
    toast(`Finishing your unfinished ${take.brand} · Video ${take.video} take first.`, 3000);
    finishTake();
  } else if (takeHere() && take.segs.length) {
    toast(`Take in progress: ${take.segs.length} part${take.segs.length > 1 ? 's' : ''}, ${fmtTake(takeTotal(take))}. Tap record to keep going, ⌫ to delete the last part, ✓ to finish.`, 3500);
  }
}

function leaveCamera() {
  if (recording || countdownCancel || finishing) return;
  unarmDelete();
  go('video');
  clearTimeout(camIdleTimer);
  camIdleTimer = setTimeout(() => { if (nav.view !== 'camera' && !recording) stopCamera(); }, 90000);
}

function renderCamTop() {
  $('camTitle').textContent = `${nav.brand} · Video ${nav.video}`;
  document.querySelectorAll('#partSeg button').forEach((b) => b.classList.toggle('on', b.dataset.part === prefs.part));
  updateEvUI();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  wake(false);
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
  const v = videoConstraints(prefs.quality, prefs.facing, prefs.facing === 'environment' ? prefs.lensId : '');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: true });
  } catch (e) {
    if (v.deviceId) { prefs.lensId = ''; savePrefs(); return startCamera(); }
    if (e && e.name === 'OverconstrainedError') {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: prefs.facing } }, audio: true }); } catch (e2) { e = e2; }
    }
    if (!stream) {
      camMsg(e && e.name === 'NotAllowedError'
        ? 'Camera or mic is blocked. iPhone Settings › Apps › Safari › Camera and Microphone › Allow, then reopen.'
        : 'Camera error: ' + ((e && e.message) || e));
      return;
    }
  }
  camMsg('');
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => {});
  applyMirror();
  listLenses();
  detectExposure();
  applyEv(true);
  wake(true);
  setTimeout(() => updateCamInfo(true), 900);
}

function applyMirror() {
  const m = prefs.facing === 'user';
  video.classList.toggle('mirror', m);
  fxCanvas.classList.toggle('mirror', m);
}

function flipCamera() {
  if (recording) { toast('Stop recording to flip the camera.', 1600); return; }
  prefs.facing = prefs.facing === 'user' ? 'environment' : 'user';
  prefs.lensId = '';
  savePrefs();
  startCamera();
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

const warned = new Set();
function updateCamInfo(warn = false) {
  const t = stream && stream.getVideoTracks()[0];
  const s = t && t.getSettings ? t.getSettings() : {};
  camActual = { w: video.videoWidth || s.width || 0, h: video.videoHeight || s.height || 0, fps: s.frameRate || 30 };
  const q = qualityOf(prefs.quality);
  const got = resLabel(camActual.w, camActual.h, camActual.fps);
  const fxNote = comp.active ? ' (effects/Darken on: records up to 1080p)' : '';
  $('resBadge').textContent = t ? got + (comp.active ? ' · FX' : '') : '';
  $('camInfo').textContent = t
    ? `Asked for ${q.label}. Camera gave ${camActual.w || '?'}×${camActual.h || '?'} at ${Math.round(camActual.fps)} fps${fxNote}. Recording format: ${pickMimeType((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || 'browser default'}.`
    : '';
  if (warn && t && camActual.w) {
    const short = Math.min(camActual.w, camActual.h);
    const lowRes = short < q.h * 0.9;
    const lowFps = q.fps >= 60 && camActual.fps < 50;
    const key = prefs.quality + prefs.facing + prefs.lensId;
    if ((lowRes || lowFps) && !warned.has(key)) {
      warned.add(key);
      toast(`Asked for ${q.label}, the camera gave ${got}. That's the most this browser allows on this camera.`, 4500);
    }
  }
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
/* Exposure: real camera exposure when the browser allows it, else the */
/* optional canvas "Darken" fallback                                   */
/* ------------------------------------------------------------------ */
let expo = { supported: false, min: -2, max: 0, step: 0.1, modes: [] };
const evRange = () => (expo.supported ? [expo.min, expo.max, expo.step] : [-2, 0, 0.1]);
const curEv = () => Number(prefs.ev[prefs.part] != null ? prefs.ev[prefs.part] : (DEFAULT_EV[prefs.part] || 0));
const evActive = () => expo.supported || prefs.darken;
function videoTrack() { return stream && stream.getVideoTracks()[0]; }

function detectExposure() {
  const t = videoTrack();
  let caps = {};
  try { caps = t && t.getCapabilities ? t.getCapabilities() : {}; } catch (e) { caps = {}; }
  expo = exposureSupport(caps);
}

let evTimer = null;
let evWant = 0;
function applyEv(immediate = false) {
  const [min, max, step] = evRange();
  const ev = clampEv(curEv(), min, max, step);
  if (expo.supported) {
    if (comp.darkAlpha) { comp.setDarken(0); updateFx(); }
    evWant = ev;
    const run = async () => {
      evTimer = null;
      const t = videoTrack();
      if (!t || !t.applyConstraints) return;
      const adv = { exposureCompensation: evWant };
      if (expo.modes.includes('continuous')) adv.exposureMode = 'continuous';
      try { await t.applyConstraints({ advanced: [adv] }); } catch (e) { /* camera refused; keep going */ }
    };
    if (immediate) { clearTimeout(evTimer); run(); } else if (!evTimer) evTimer = setTimeout(run, 70);
  } else {
    comp.setDarken(prefs.darken ? evToDarkAlpha(ev) : 0);
    updateFx();
  }
  updateEvUI();
}

function setEv(ev) {
  const [min, max, step] = evRange();
  prefs.ev[prefs.part] = clampEv(ev, min, max, step);
  savePrefs();
  applyEv();
}

function updateEvUI() {
  const [min, max, step] = evRange();
  const ev = clampEv(curEv(), min, max, step);
  const on = evActive() && ev !== 0;
  $('evLabel').textContent = on ? fmtEv(ev) : 'Exposure';
  $('evBtn').classList.toggle('on', on);
  $('evPart').textContent = PART_LABELS[prefs.part];
  $('evNow').textContent = evActive() ? fmtEv(ev) + ' EV' : 'off';
  $('evSupport').textContent = !stream ? 'Open the camera to check exposure support.'
    : expo.supported ? `✓ This camera lets the app set exposure (${fmtEv(expo.min)} to ${fmtEv(expo.max)} EV).`
    : 'Exposure control is not supported on this device: iPhone Safari does not let web apps change camera exposure. ' +
      'Turn on Darken below to darken the picture inside the app instead (only darker, and it records at 1080p max while on).';
  $('darkRow').hidden = expo.supported || !stream;
  $('darkOn').checked = !!prefs.darken;
  const r = $('evRange');
  r.min = min; r.max = max; r.step = step; r.value = ev;
  r.disabled = !evActive();
  $('evVal').textContent = fmtEv(ev);
  $('evMode').textContent = expo.supported ? 'camera' : prefs.darken ? 'darken' : '';
}

let evBarTimer = null;
function flashEvBar(ms = 900) {
  $('evBar').hidden = false;
  clearTimeout(evBarTimer);
  evBarTimer = setTimeout(() => { $('evBar').hidden = true; }, ms);
}

function setPart(p) {
  if (!PARTS.includes(p)) return;
  prefs.part = p;
  savePrefs();
  if (takeHere() && take.part !== p) { take.part = p; saveTake(); }
  renderCamTop();
  applyEv(true);
  if (evActive() && curEv() !== 0) flashEvBar(1200);
}

/* Stage gestures: drag up/down = exposure, double-tap = flip camera, single tap = close panels */
function bindStageGestures() {
  const stage = $('stage');
  let ptr = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let toldUnsupported = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#prompter')) return;
    ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, startEv: curEv(), dragging: false };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!ptr || e.pointerId !== ptr.id) return;
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y;
    if (!ptr.dragging && Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) * 1.2) {
      ptr.dragging = true;
      closePanels();
      if (!evActive() && stream) {
        if (!toldUnsupported) {
          toldUnsupported = true;
          toast('Exposure control is not supported on this device. Turn on “Darken” in the Exposure panel to darken the picture instead.', 4500);
          togglePanel('evBtn');
          updateEvUI();
        }
        ptr = null;
        return;
      }
    }
    if (ptr.dragging) {
      const [min, max, step] = evRange();
      setEv(evFromDrag(ptr.startEv, dy, stage.clientHeight, min, max, step));
      flashEvBar(1200);
    }
  });
  const end = (e) => {
    if (!ptr || e.pointerId !== ptr.id) return;
    const wasDrag = ptr.dragging;
    const moved = Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y);
    ptr = null;
    if (wasDrag || moved > 14) return;
    const now = performance.now();
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 60) {
      lastTap = { t: 0, x: 0, y: 0 };
      flipCamera();
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      closePanels();
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', () => { ptr = null; });
  stage.addEventListener('dblclick', (e) => e.preventDefault());
}

/* ------------------------------------------------------------------ */
/* Recording: TikTok-style takes made of segments                      */
/* Record, pause (switch apps, lock the screen), record more, delete   */
/* the last segment, then ✓ joins them into one clip.                  */
/* Pause keeps MediaRecorder running POST_ROLL_MS (~300 ms) after the  */
/* tap so mid-word endings aren't cut; UI still shows paused instantly.*/
/* Each segment is its own MediaRecorder run; its pieces go to         */
/* IndexedDB every 2 s (crash-safe) and the finished segment is kept   */
/* in blobStore until the take is finished or the segment is deleted.  */
/* ------------------------------------------------------------------ */
let recording = false;
let rec = null;            // the segment being recorded right now
let recStartedAt = 0;
let recTimer = null;
let countdownCancel = null;
let take = null;           // the take being built; survives pauses, app switches and restarts
let segSaving = Promise.resolve();
let delArmedAt = 0;
let delArmTimer = null;
let finishing = false;
let finishAfterStop = false;
let liveSec = 0;

const metaKey = (id) => 'recMeta:' + id;
async function saveTake() {
  try {
    if (take && (take.segs.length || recording)) await kv.set('takeActive', take);
    else await kv.del('takeActive');
  } catch (e) { /* storage problem: the take stays in memory */ }
}
const takeHere = () => !!(take && take.brand === nav.brand && Number(take.video) === Number(nav.video) && take.day === nav.day);

/** Camera is usable for a new segment (iOS can hand back a dead or muted track after the app was in the background). */
function camReady() {
  return streamLive() && stream.getTracks().every((t) => t.readyState === 'live' && !t.muted);
}

async function onRecButton() {
  closePanels();
  unarmDelete();
  if (countdownCancel) { countdownCancel(); return; }
  if (recording) { pauseSegment(); return; }
  if (finishing) return;
  if (!window.MediaRecorder) { toast('This browser cannot record video. Update iOS (14.3 or newer).'); return; }
  if (take && !takeHere() && take.segs.length) { await finishTake(); return; }
  if (take && prefs.maxLen && takeTotal(take) >= prefs.maxLen - 0.2) {
    toast(`This take is at the ${prefs.maxLen}s limit. Tap ✓ to finish it, or delete the last part.`, 3500);
    return;
  }
  await segSaving;
  if (!camReady()) { await startCamera(); if (!streamLive()) return; }
  if (prefs.countdown) {
    const go2 = await runCountdown(prefs.countdown);
    if (!go2) return;
  }
  startSegment();
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

function startSegment() {
  let recStream = stream;
  let fxUsed = false;
  let segFx = null;
  if (comp.active) {
    if (comp.canRecord) {
      segFx = comp.captureTrack(camActual.fps >= 50 ? 60 : 30);
      recStream = new MediaStream([segFx].concat(stream.getAudioTracks()));
      fxUsed = true;
    } else {
      toast('This phone cannot record the effect, recording the plain camera.');
    }
  }
  const q = qualityOf(prefs.quality);
  const mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
  const bits = fxUsed ? Math.min(q.bits, q.fps >= 60 ? 20e6 : 12e6) : q.bits;
  const opts = { videoBitsPerSecond: bits, audioBitsPerSecond: 160000 };
  if (mime) opts.mimeType = mime;
  let recorder;
  try {
    recorder = new MediaRecorder(recStream, opts);
  } catch (e) {
    try { recorder = new MediaRecorder(recStream); } catch (e2) { if (segFx) segFx.stop(); toast('Could not start recording: ' + e2.message); return; }
  }
  if (!takeHere()) take = newTake({ id: uid(), brand: nav.brand, video: nav.video, day: nav.day, part: prefs.part, startedAt: Date.now() });
  const firstOfTake = !take.segs.length;
  const useChunks = !!prefs.chunked && typeof indexedDB !== 'undefined';
  const r = {
    id: uid(), recorder, useChunks, seq: 0, mem: new Map(), chunks: [], writes: Promise.resolve(), fxTrack: segFx, done: () => {},
    meta: {
      recordedAt: Date.now(), camera: prefs.facing === 'user' ? 'front' : 'back', effect: comp.active ? (prefs.gs !== 'off' ? prefs.gs : 'darken') : 'none',
      brand: nav.brand, video: nav.video, day: nav.day, part: take.part,
      width: fxUsed ? fxCanvas.width : camActual.w, height: fxUsed ? fxCanvas.height : camActual.h, fps: Math.round(camActual.fps || 30),
      takeId: take.id, takeStartedAt: take.startedAt, promptY: firstOfTake ? 0 : prompterY
    }
  };
  r.meta.recId = r.id;
  if (useChunks) kv.set(metaKey(r.id), r.meta).catch(() => {});
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    if (!r.useChunks) { r.chunks.push(e.data); return; }
    const seq = r.seq++;
    const blob = e.data;
    r.writes = r.writes.then(() => recParts.put(r.id, seq, blob)).catch(() => { r.mem.set(seq, blob); });
  };
  recorder.onstop = () => onRecorderStop(r);
  recorder.onerror = (e) => toast('Recording error: ' + ((e.error && e.error.message) || 'unknown'));
  try {
    if (useChunks) recorder.start(2000); else recorder.start(1000);
  } catch (e) {
    if (segFx) segFx.stop();
    toast('Could not start recording: ' + e.message);
    return;
  }
  rec = r;
  recording = true;
  recStartedAt = performance.now();
  liveSec = 0;
  document.body.classList.add('recording');
  recTimer = setInterval(tickRec, 200);
  startPrompter(firstOfTake);
  wake(true);
  saveTake();
  renderTakeUI();
}

function tickRec() {
  liveSec = (performance.now() - recStartedAt) / 1000;
  const total = takeTotal(take, liveSec);
  renderTakeUI();
  if (prefs.maxLen && total >= prefs.maxLen) { finishAfterStop = true; pauseSegment(); }
}

/**
 * Ends the current segment (record button, ✓ finish, app switch, screen lock, auto-stop).
 * UI goes to paused immediately, but MediaRecorder keeps running POST_ROLL_MS longer so the
 * end of a word isn't chopped when Carson taps pause mid-word. The take stays open.
 * Pass { immediate: true } on pagehide so we flush before the page dies.
 */
function pauseSegment(opts = {}) {
  if (!rec) return;
  if (rec.postRolling) {
    if (opts.immediate && rec.stopNow) { clearTimeout(rec.postRollTimer); rec.stopNow(); }
    return;
  }
  if (!recording && rec.recorder.state !== 'recording') return;
  const r = rec;
  r.postRolling = true;
  r.pauseTapAt = performance.now();
  recording = false; // UI shows paused right away; recorder still running
  clearInterval(recTimer);
  liveSec = 0;
  // duration includes the post-roll we're about to keep (refined when we actually stop)
  const keepMs = opts.immediate ? 0 : POST_ROLL_MS;
  const dur = Math.round(((r.pauseTapAt - recStartedAt) / 1000 + keepMs / 1000) * 10) / 10;
  r.meta.durationSec = dur;
  const m = r.meta;
  // placeholder right away so the bar and the order are correct; filled in once the bytes are saved
  addSegment(take, {
    id: r.id, startedAt: m.recordedAt, durationSec: dur, camera: m.camera, effect: m.effect, width: m.width || null,
    height: m.height || null, fps: m.fps || null, promptY: m.promptY, saving: true
  });
  segSaving = new Promise((res) => { r.done = res; });
  document.body.classList.remove('recording');
  stopPrompter();
  renderTakeUI();
  let stopped = false;
  r.stopNow = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(r.postRollTimer);
    const actual = Math.round((performance.now() - recStartedAt) / 100) / 10;
    r.meta.durationSec = actual;
    const seg = take && take.segs.find((s) => s.id === r.id);
    if (seg) seg.durationSec = actual;
    rec = null;
    try {
      if (r.recorder && r.recorder.state === 'recording') r.recorder.stop();
      else onRecorderStop(r);
    } catch (e) { onRecorderStop(r); }
  };
  if (keepMs <= 0) r.stopNow();
  else r.postRollTimer = setTimeout(r.stopNow, keepMs);
}

async function onRecorderStop(r) {
  if (r.stopped) return;
  r.stopped = true;
  if (r.fxTrack) { r.fxTrack.stop(); r.fxTrack = null; }
  const type = ((r.recorder && r.recorder.mimeType) || 'video/mp4').split(';')[0] || 'video/mp4';
  let blob;
  if (r.useChunks) {
    await r.writes;
    let saved = [];
    try { saved = await recParts.list(r.id); } catch (e) { saved = []; }
    blob = new Blob(orderParts(saved, r.mem), { type });
  } else {
    blob = new Blob(r.chunks, { type });
    r.chunks = [];
  }
  const seg = take && take.segs.find((s) => s.id === r.id);
  try {
    if (!blob.size) throw Object.assign(new Error('empty'), { empty: true });
    await blobStore.put(r.id, blob);
    if (seg) Object.assign(seg, { saving: false, mime: type, size: blob.size });
    else await blobStore.del(r.id); // the take was thrown away meanwhile
    await saveTake(); // record the part in the take BEFORE dropping its crash-safe pieces
    if (r.useChunks) { recParts.delAll(r.id).catch(() => {}); kv.del(metaKey(r.id)).catch(() => {}); }
  } catch (e) {
    if (seg) take.segs.splice(take.segs.indexOf(seg), 1);
    toast(e && e.empty ? 'Nothing was recorded. Try again.'
      : 'Phone storage is full. Clear space; this part stays saved in pieces and comes back next time you open the app.', 6000);
    finishAfterStop = false;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await saveTake();
  r.done();
  renderTakeUI();
  if (finishAfterStop) { finishAfterStop = false; finishTake(); }
}

function unarmDelete() {
  if (!delArmedAt) return;
  delArmedAt = 0;
  clearTimeout(delArmTimer);
  renderTakeUI();
}

/** ⌫: first tap marks the last segment, second tap (within 3 s) deletes it. Repeat to keep going back. */
async function onDeleteSeg() {
  if (recording || finishing || countdownCancel) return;
  await segSaving;
  if (!take || !take.segs.length) return;
  const t = deleteTap(delArmedAt, Date.now());
  if (t.action === 'arm') {
    delArmedAt = t.armedAt;
    clearTimeout(delArmTimer);
    delArmTimer = setTimeout(unarmDelete, DELETE_CONFIRM_MS);
    renderTakeUI();
    return;
  }
  delArmedAt = 0;
  clearTimeout(delArmTimer);
  const s = removeLastSegment(take);
  await blobStore.del(s.id).catch(() => {});
  recParts.delAll(s.id).catch(() => {});
  if (s.promptY != null) { prompterY = s.promptY; setPrompterY(); }
  const left = take.segs.length;
  const total = takeTotal(take);
  if (!left) take = null;
  await saveTake();
  renderTakeUI();
  toast(left ? `Deleted the last part. Back to ${fmtTake(total)}.` : 'Deleted. Start a new take.', 1800);
}

/** Resolves true unless the video fires an error while loading (iOS may not preload; that's not a failure). */
function playable(blob, ms = 6000) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    const url = URL.createObjectURL(blob);
    let timer = null;
    const done = (ok) => {
      clearTimeout(timer);
      v.onloadedmetadata = v.onerror = null;
      v.removeAttribute('src');
      try { v.load(); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    v.onloadedmetadata = () => done(true);
    v.onerror = () => done(false);
    timer = setTimeout(() => done(true), ms);
    v.src = url;
  });
}

/**
 * ✓: joins the take's segments into ONE clip (lossless fMP4 join, see mp4join.js) and opens the
 * review sheet. If this phone's recordings can't be joined, the segments become separate clips
 * with JOIN notes and in-order names, and the editor concatenates them.
 */
async function finishTake() {
  if (finishing) return;
  if (recording) { finishAfterStop = true; pauseSegment(); return; }
  unarmDelete();
  await segSaving;
  if (!take || !take.segs.length) { toast('Record something first.'); return; }
  finishing = true;
  renderTakeUI();
  const t = take;
  try {
    const blobs = [];
    for (const s of t.segs) blobs.push(await blobStore.get(s.id).catch(() => null));
    const keep = t.segs.filter((s, i) => blobs[i] && blobs[i].size);
    const kb = blobs.filter((b) => b && b.size);
    if (!keep.length) { toast('The recorded parts are missing from this phone. Start a new take.', 4000); take = null; await saveTake(); return; }
    t.segs = keep;
    const s0 = keep[0];
    const type = String(s0.mime || kb[0].type || 'video/mp4').split(';')[0];
    const base = {
      camera: s0.camera || '', effect: s0.effect || 'none', source: 'camera', brand: t.brand, video: t.video, day: t.day,
      part: t.part, status: 'draft', width: s0.width || null, height: s0.height || null, fps: s0.fps || null
    };
    let items = null;
    let outBlobs = null;
    let why = '';
    if (keep.length === 1) {
      const c = Object.assign({}, base, { id: s0.id, createdAt: Date.now(), recordedAt: t.startedAt, durationSec: takeTotal(t), mime: type, size: kb[0].size, note: '' });
      await clipsStore.put(c);
      items = [c]; outBlobs = [kb[0]];
    } else if (/mp4/.test(type) && kb.every((b) => /mp4/.test(b.type || type))) {
      toast(`Joining ${keep.length} parts…`, 1500);
      try {
        const j = await joinFmp4(kb, type);
        if (!(await playable(j.blob))) throw new Error('the joined file did not open');
        const c = Object.assign({}, base, {
          id: uid(), createdAt: Date.now(), recordedAt: t.startedAt, durationSec: takeTotal(t), mime: type, size: j.blob.size,
          note: '', segments: keep.length
        });
        await blobStore.put(c.id, j.blob);
        await clipsStore.put(c);
        for (const s of keep) await blobStore.del(s.id).catch(() => {});
        items = [c]; outBlobs = [j.blob];
      } catch (e) {
        why = (e && e.message) || String(e);
      }
    } else why = 'not MP4';
    if (!items) {
      // Fallback: one clip per kept segment (the segment's bytes are already stored under its id: no copy).
      const plan = segmentClipPlan(t, ptTimeToken);
      items = keep.map((s, i) => Object.assign({}, base, {
        id: s.id, createdAt: Date.now() + i, recordedAt: plan[i].recordedAt, durationSec: s.durationSec, mime: s.mime || type, size: kb[i].size,
        note: plan[i].note, segIndex: plan[i].index, segCount: plan[i].count, takeTag: plan[i].takeTag,
        width: s.width || base.width, height: s.height || base.height, fps: s.fps || base.fps, camera: s.camera || base.camera
      }));
      for (const c of items) await clipsStore.put(c);
      outBlobs = kb;
      console.warn('Grok Film: segments not joined on the phone:', why);
      toast(`Couldn't join the ${keep.length} parts on this phone, so they upload as ${keep.length} files in order and the editor joins them.`, 5000);
    }
    take = null;
    await saveTake();
    allClips.push(...items);
    openReview(items, outBlobs);
  } catch (e) {
    toast('Could not finish the take: ' + ((e && e.message) || e) + '. Your parts are still saved; try ✓ again.', 6000);
  } finally {
    finishing = false;
    renderTakeUI();
  }
}

/** Progress bar with ticks, total time, ⌫ and ✓. */
function renderTakeUI() {
  const segs = takeHere() ? take.segs : [];
  const has = segs.length > 0 || recording;
  document.body.classList.toggle('take', has && !recording);
  $('segBar').hidden = !has;
  const total = takeTotal(takeHere() ? take : null, recording ? liveSec : 0);
  const pieces = barLayout(segs, recording ? liveSec : null, barScale(prefs.maxLen, total));
  $('segBar').innerHTML = pieces.map((p, i) => {
    const cls = p.live ? 'live' : (delArmedAt && i === segs.length - 1 ? 'armed' : '') + (segs[i] && segs[i].saving ? ' saving' : '');
    return `<i class="${cls}" style="left:${p.left.toFixed(2)}%;width:${p.width.toFixed(2)}%"></i>`;
  }).join('');
  $('recTime').hidden = !has;
  $('recTime').textContent = fmtTake(total) + (prefs.maxLen ? ` / ${fmtTake(prefs.maxLen)}` : '');
  $('recTime').classList.toggle('paused', !recording);
  $('segDel').hidden = !segs.length || recording;
  $('segNext').hidden = !segs.length && !recording;
  $('segDel').classList.toggle('armed', !!delArmedAt);
  $('segDelLabel').textContent = delArmedAt ? 'Tap again' : 'Delete';
  $('segNext').disabled = finishing;
  $('segCount').textContent = segs.length > 1 || (segs.length && recording) ? `${segs.length + (recording ? 1 : 0)} parts` : '';
}

/**
 * On launch: restore the take in progress, and turn recording pieces left by a crash into either
 * a segment of that take (when it was part of one) or a draft clip in its video folder.
 */
async function recoverTakes() {
  let saved = null;
  let legacy = null;
  try { saved = await kv.get('takeActive'); legacy = await kv.get('recActive'); } catch (e) { return; }
  if (saved && Array.isArray(saved.segs)) {
    const have = [];
    for (const s of saved.segs) {
      const b = await blobStore.get(s.id).catch(() => null);
      if (b && b.size) { have.push(s.id); if (!s.size) s.size = b.size; if (!s.mime) s.mime = b.type; }
      s.saving = false;
    }
    pruneMissing(saved, have);
    take = saved;
  }
  let ids = [];
  try { ids = await recParts.recIds(); } catch (e) { ids = []; }
  let drafts = 0;
  let segsBack = 0;
  for (const id of ids) {
    if (rec && rec.id === id) continue;
    const got = await recParts.list(id).catch(() => []);
    const parts = orderParts(got.filter((p) => p.blob));
    if (!parts.length) { await recParts.delAll(id).catch(() => {}); continue; }
    let m = await kv.get(metaKey(id)).catch(() => null);
    if (!m && legacy && legacy.recId === id) m = legacy;
    m = m || {};
    const type = String(parts[0].type || 'video/mp4').split(';')[0] || 'video/mp4';
    const blob = new Blob(parts, { type });
    try {
      if (m.takeId) {
        if (!take || take.id !== m.takeId) {
          if (take && take.segs.length) { /* a different take is open: keep this one as a draft instead */ m.takeId = null; }
          else take = newTake({ id: m.takeId, brand: m.brand, video: m.video, day: m.day, part: m.part, startedAt: m.takeStartedAt || m.recordedAt });
        }
      }
      if (m.takeId) {
        if (!take.segs.some((s) => s.id === id)) {
          const d = /mp4/.test(type) ? await fmp4Duration(blob) : null;
          if (/mp4/.test(type) && !(d > 0.2)) { // only the header made it to disk: nothing to keep
            await recParts.delAll(id).catch(() => {});
            kv.del(metaKey(id)).catch(() => {});
            continue;
          }
          await blobStore.put(id, blob);
          addSegment(take, {
            id, startedAt: m.recordedAt || Date.now(), durationSec: d ? Math.round(d * 10) / 10 : 0, mime: type, size: blob.size,
            camera: m.camera || '', effect: m.effect || 'none', width: m.width || null, height: m.height || null, fps: m.fps || null,
            promptY: m.promptY, recovered: true
          });
          take.segs.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
          segsBack++;
        }
      } else {
        const c = {
          id: uid(), createdAt: Date.now(), recordedAt: m.recordedAt || Date.now(), durationSec: null, mime: type, size: blob.size,
          camera: m.camera || '', effect: m.effect || 'none', source: 'camera', brand: m.brand || BRANDS[0], video: m.video || null,
          day: m.day || null, part: m.part || 'HOOK', note: 'Recovered take (the app closed while recording)', status: 'draft'
        };
        await blobStore.put(c.id, blob);
        await clipsStore.put(c);
        drafts++;
      }
      await recParts.delAll(id);
      kv.del(metaKey(id)).catch(() => {});
    } catch (e) { /* storage full: leave the pieces for next time */ }
  }
  kv.del('recActive').catch(() => {});
  if (take && !take.segs.length) take = null;
  await saveTake();
  if (drafts) toast(`Recovered ${drafts} take(s) that were recording when the app closed. They're in their video folder as drafts.`, 5000);
  else if (take) toast(`Your ${take.brand} · Video ${take.video} take is still here (${take.segs.length} part${take.segs.length > 1 ? 's' : ''}, ${fmtTake(takeTotal(take))}${segsBack ? ', including the part that was recording when the app closed' : ''}). Open the camera to keep going.`, 5000);
}

/* ------------------------------------------------------------------ */
/* Review + tag (after a take, or after importing clips)              */
/* ------------------------------------------------------------------ */
const review = { items: null, blobs: null, part: '', video: null, url: null, idx: 0 };

/** Shows blob i in the review player. A take that uploads as separate parts plays them one after another. */
function reviewPlay(i) {
  const v = $('reviewVid');
  review.idx = i;
  if (review.url) URL.revokeObjectURL(review.url);
  review.url = URL.createObjectURL(review.blobs[i]);
  v.loop = review.blobs.length === 1;
  v.src = review.url;
  v.play().catch(() => {});
}

function openReview(items, blobs) {
  review.items = items;
  review.blobs = blobs;
  const first = items[0];
  review.part = PARTS.includes(first.part) ? first.part : prefs.part;
  review.video = first.video || null;
  const v = $('reviewVid');
  v.onended = () => { if (review.blobs && review.blobs.length > 1 && first.segCount) reviewPlay((review.idx + 1) % review.blobs.length); };
  reviewPlay(0);
  $('reviewNote').value = first.note && !/^Recovered take/.test(first.note) ? userPartOfNote(first.note) : '';
  renderChips($('reviewParts'), PARTS.map((p) => ({ v: p, label: PART_LABELS[p] })), review.part, (p) => { review.part = p; reviewInfo(); }, 'part');
  const day = first.day || ptDayKey(new Date(first.recordedAt));
  const opts = videoNums(dayState(first.brand, day)).map((k) => ({ v: k, label: 'Video ' + k }));
  if (review.video && !opts.some((o) => Number(o.v) === Number(review.video))) opts.push({ v: review.video, label: 'Video ' + review.video });
  if (!review.video) opts.unshift({ v: '', label: 'Day folder (no video)' });
  renderChips($('reviewVideos'), opts, review.video || '', (k) => { review.video = k ? Number(k) : null; reviewInfo(); });
  $('retakeBtn').textContent = first.source === 'camera' ? 'Retake' : 'Cancel';
  $('photosBtn').hidden = !(navigator.canShare && items.length === 1);
  reviewInfo();
  openSheet('s-review');
}

function reviewInfo() {
  const c = review.items[0];
  const size = review.blobs.reduce((n, b) => n + b.size, 0);
  const day = c.day || ptDayKey(new Date(c.recordedAt));
  const name = clipName(review.part, c.brand, new Date(c.recordedAt), c.mime, c.origName, review.video);
  const res = c.width && c.height ? ` · ${resLabel(c.width, c.height, c.fps)}` : '';
  const dur = review.items.reduce((n, x) => n + (Number(x.durationSec) || 0), 0);
  const multi = review.items.length > 1;
  $('reviewInfo').textContent = (multi ? (c.segCount ? `${review.items.length} parts, uploaded in order for the editor to join · ` : `${review.items.length} clips · `)
    : c.segments ? `${c.segments} parts joined · ` : '') +
    (dur ? fmtDur(dur) + ' · ' : '') + fmtBytes(size) + res +
    ` → ${c.brand} / ${dayKeyToFolderName(day)}${review.video ? ' / Video ' + review.video : ''} / ${review.items.length > 1 ? review.part + '_…' : name}`;
}

function hideReview() {
  const v = $('reviewVid');
  v.onended = null;
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
    Object.assign(c, { part: review.part, video: review.video, note: c.segCount ? mergeSegNote(c.note, note) : note, status: 'queued' });
    if (!c.day) c.day = ptDayKey(new Date(c.recordedAt));
    await clipsStore.put(c);
  }
  if (first.source === 'camera' && nav.view === 'camera' && review.part !== prefs.part) setPart(review.part);
  const where = `${first.brand}${review.video ? ' / Video ' + review.video : ''}`;
  hideReview();
  toast(cfg.url ? `Saved ✓ Uploading to ${where}` : 'Saved on this device. Connect Drive in Settings to upload.');
  refreshQueueUI();
  uploader.run();
}

async function discardReview(fromBackdrop = false) {
  if (!review.items) { hideReview(); return; }
  const c = review.items[0];
  if (fromBackdrop) {
    hideReview();
    toast('Kept as a draft. Tag it from the video folder.');
    refreshQueueUI();
    return;
  }
  const len = review.items.reduce((n, x) => n + (Number(x.durationSec) || 0), 0);
  if (c.source === 'camera' && len > 5 && !confirm('Delete this take?')) return;
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
  const name = clipName(review.part, c.brand, new Date(c.recordedAt), c.mime, c.origName, review.video);
  const file = new File([review.blobs[0]], name, { type: c.mime || 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { /* cancelled */ }
  } else {
    toast('Saving to Photos is not supported here.');
  }
}

/** Camera roll / computer files into the current video folder. REF files upload right away. */
async function importFiles(files, part) {
  const items = [];
  const blobs = [];
  for (const f of files) {
    const c = {
      id: uid(), createdAt: Date.now() + items.length, recordedAt: Date.now(), durationSec: null,
      mime: f.type || (part === 'REF' ? 'image/jpeg' : 'video/mp4'), size: f.size, camera: '',
      source: part === 'REF' ? 'ref' : 'import', origName: f.name || '', brand: nav.brand, video: nav.video, day: nav.day,
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

/** The effects canvas covers the camera whenever green screen or Darken is on. */
function updateFx() {
  fxCanvas.hidden = !comp.active;
  if (stream) updateCamInfo();
}

async function setGs(mode, interactive = true) {
  if (mode === 'image' && !comp.bg && interactive) $('bgInput').click();
  prefs.gs = mode;
  savePrefs();
  document.querySelectorAll('#gsModes .chip').forEach((c) => c.classList.toggle('on', c.dataset.gs === mode));
  $('gsBtn').classList.toggle('on', mode !== 'off');
  if (mode !== 'off' && !comp.canRecord) $('gsStatus').textContent = 'Preview only: this browser cannot record effects.';
  await comp.setMode(mode);
  updateFx();
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
/** reset = start of a new take; later segments of the same take continue where the text paused. */
function startPrompter(reset = true) {
  if ($('prompter').hidden) return;
  if (reset) prompterY = 0;
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
/* Settings                                                            */
/* ------------------------------------------------------------------ */
async function openSettings() {
  $('cfgUrl').value = cfg.url || '';
  $('cfgKey').value = cfg.key || '';
  $('cfgLink').value = '';
  $('quality').value = prefs.quality;
  $('maxLen').value = String(prefs.maxLen);
  $('chunkedRec').checked = !!prefs.chunked;
  $('versionInfo').textContent = `Grok Film ${APP_VERSION}${isStandalone ? ' · installed' : ' · in browser'}`;
  setConn(cfg.url ? 'Connected (tap Save & test to check).' : 'Not connected yet. Paste the setup link from Grok Bot.', cfg.url ? '' : 'bad');
  updateCamInfo();
  if (!stream) $('camInfo').textContent = `Quality: ${qualityOf(prefs.quality).label}. Open the camera to see what it actually gives.`;
  openSheet('s-settings');
  try {
    const all = await clipsStore.all();
    const waiting = all.filter((c) => c.status !== 'done');
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    $('storageInfo').textContent = `${waiting.length} clip(s) on this device waiting to upload (${fmtBytes(waiting.reduce((n, c) => n + (c.size || 0), 0))}).` +
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
  // folders
  $('bBack').onclick = () => go(nav.view === 'video' ? 'brand' : 'home');
  $('bSettings').onclick = openSettings;
  $('bQueue').onclick = () => (cfg.url ? openUploads() : openSettings());
  $('dayPrev').onclick = () => { nav.day = shiftDayKey(nav.day, -1); renderBrowser(); };
  $('dayNext').onclick = () => { nav.day = shiftDayKey(nav.day, 1); renderBrowser(); };
  $('brandList').onclick = (e) => { const b = e.target.closest('[data-brand]'); if (b) go('brand', { brand: b.dataset.brand, video: null }); };
  $('videoList').onclick = (e) => { const b = e.target.closest('[data-video]'); if (b) go('video', { video: Number(b.dataset.video) }); };
  $('addVideo').onclick = addVideo;
  $('addBrand').onclick = () => {
    const name = $('newBrand').value.trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._&-]{0,39}$/.test(name)) { toast('Use letters and numbers only.'); return; }
    if (!allBrands().includes(name)) prefs.brands = (prefs.brands || []).concat([name]);
    savePrefs();
    $('newBrand').value = '';
    renderBrowser();
  };
  $('filmBtn').onclick = () => go('camera');
  $('vImport').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const { items, blobs } = await importFiles(files);
    if (items.length) openReview(items, blobs);
  };
  $('vRefAdd').onclick = addRefsFromInput;
  $('vRefUrl').onkeydown = (e) => { if (e.key === 'Enter') addRefsFromInput(); };
  $('vRefUrl').addEventListener('paste', () => setTimeout(() => { if (extractUrls($('vRefUrl').value).length) addRefsFromInput(); }, 30));
  $('vRefList').onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    editVideo((v) => { v.refLinks.splice(Number(b.dataset.i), 1); });
  };
  $('vRefFiles').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const { items } = await importFiles(files, 'REF');
    toast(`${items.length} reference file(s) uploading to Video ${nav.video}`);
    refreshQueueUI();
    uploader.run();
  };
  $('vNotes').oninput = () => {
    const val = $('vNotes').value;
    const { brand, day, video: k } = nav;
    const st = dayState(brand, day);
    const v = vget(st, k);
    v.notes = val;
    v.dirty = true;
    putDay(brand, day, st);
    schedulePush(brand, day, k, 1500);
    $('vSync').textContent = 'Saving to Drive…';
  };
  $('vNotes').onblur = () => renderBrowser();
  $('vDone').onclick = onDone;
  $('vReopen').onclick = onReopen;
  $('vClips').onclick = onClipAction;
  $('upClips').onclick = onClipAction;
  $('upRetry').onclick = () => { uploader.retryAll(); toast('Retrying failed uploads…'); };

  // camera
  $('camBack').onclick = leaveCamera;
  $('folderBtn').onclick = leaveCamera;
  $('recBtn').onclick = onRecButton;
  $('segDel').onclick = onDeleteSeg;
  $('segNext').onclick = finishTake;
  $('flipBtn').onclick = flipCamera;
  $('lensBtn').onclick = () => {
    if (recording || lenses.length < 2) return;
    const i = lenses.findIndex((l) => l.id === prefs.lensId);
    const cur = i >= 0 ? i : lenses.findIndex((l) => l.label === '1x');
    const next = lenses[(cur + 1) % lenses.length];
    prefs.lensId = next.id;
    savePrefs();
    startCamera();
  };
  $('partSeg').onclick = (e) => { const b = e.target.closest('[data-part]'); if (b) setPart(b.dataset.part); };
  bindStageGestures();

  $('evBtn').onclick = () => { togglePanel('evBtn'); updateEvUI(); };
  $('evRange').oninput = (e) => { setEv(Number(e.target.value)); flashEvBar(); };
  $('evReset').onclick = () => setEv(0);
  $('evDemo').onclick = () => {
    if (prefs.part !== 'DEMO') setPart('DEMO');
    setEv(DEFAULT_EV.DEMO);
    flashEvBar();
  };
  $('darkOn').onchange = (e) => {
    prefs.darken = e.target.checked;
    savePrefs();
    applyEv(true);
    if (prefs.darken) toast(`Darken on. Drag down on the camera to darken (${PART_LABELS[prefs.part]} remembers its own level). Records at 1080p max while darkened.`, 4500);
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
  $('prompter').onclick = () => { if (!prompterRAF) startPrompter(!(takeHere() && take.segs.length)); else prompterPaused = !prompterPaused; };

  $('settingsBtn').onclick = openSettings;
  $('queueBtn').onclick = () => (cfg.url ? openUploads() : openSettings());

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

  $('cfgSave').onclick = saveSettings;
  $('pasteLink').onclick = async () => {
    try { $('cfgLink').value = await navigator.clipboard.readText(); } catch (e) { toast('Long-press the box and tap Paste.'); }
  };
  $('quality').onchange = (e) => {
    prefs.quality = e.target.value;
    savePrefs();
    if (stream) startCamera();
    if (prefs.quality.startsWith('4k')) toast('4K: keep "Crash-safe recording" on. 4K files are big (about 300–500 MB a minute), so uploads take longer.', 4500);
  };
  $('maxLen').onchange = (e) => { prefs.maxLen = Number(e.target.value); savePrefs(); };
  $('chunkedRec').onchange = (e) => { prefs.chunked = e.target.checked; savePrefs(); };
  $('retryAll').onclick = () => { uploader.retryAll(); toast('Retrying failed uploads…'); };
  $('clearDone').onclick = async () => {
    for (const c of await clipsStore.all()) if (c.status === 'done') await clipsStore.del(c.id);
    refreshQueueUI();
    toast('Cleared');
  };
  $('tipClose').onclick = () => { $('installTip').hidden = true; LS.set('tipDone', true); };

  video.addEventListener('resize', () => updateCamInfo());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // switching apps / locking the screen pauses the take; the segment so far is kept
      if (countdownCancel) countdownCancel();
      if (recording) pauseSegment();
      unarmDelete();
      return;
    }
    if (nav.view === 'camera' && !recording && !camReady()) startCamera(); // iOS ends or mutes the camera in the background
    if (nav.view === 'camera') { wake(true); renderTakeUI(); }
    if (nav.brand && nav.view !== 'home') syncDay(nav.brand, nav.day);
    if (nav.day < ptDayKey() && nav.view === 'home') { nav.day = ptDayKey(); renderBrowser(); }
    uploader.run();
  });
  window.addEventListener('pagehide', () => {
    if (recording || (rec && rec.postRolling)) pauseSegment({ immediate: true });
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted && nav.view === 'camera' && !recording && !camReady()) startCamera(); });
  window.addEventListener('focus', () => { if (nav.brand && nav.view !== 'home' && nav.view !== 'camera') syncDay(nav.brand, nav.day); });
  window.addEventListener('online', () => uploader.run());
  window.addEventListener('hashchange', () => { consumeSetupHash(); refreshQueueUI(); });
  setInterval(() => { if (!document.hidden) uploader.run(); }, 30000);
  // pick up links dumped from the other device while a folder is open
  setInterval(() => { if (!document.hidden && nav.brand && (nav.view === 'brand' || nav.view === 'video')) syncDay(nav.brand, nav.day); }, 60000);
  setInterval(() => { if (!document.hidden) checkDone(); }, 15000);
}

async function init() {
  consumeSetupHash();
  bind();
  applyRing();
  applyScript();
  applyGrid();
  updateTimer();
  updateEvUI();
  comp.onStatus = (m) => { $('gsStatus').textContent = m; if (m) toast(m, 3500); };
  pruneDayStates();
  go('home');
  try {
    const bg = await kv.get('bg');
    if (bg) { await comp.setBackground(bg); renderBgThumb(bg); }
  } catch (e) { /* no saved background */ }
  if (prefs.gs !== 'off') setGs(prefs.gs, false);
  try { await recoverTakes(); } catch (e) { /* ignore */ }
  try { await pruneOld(); } catch (e) { /* ignore */ }
  await refreshQueueUI();
  uploader.run();
  if (!cfg.url) setTimeout(() => toast('Tap "Set up" (top right) to connect Drive.', 3500), 1200);
  if (isIOS && !isStandalone && !LS.get('tipDone', false)) $('installTip').hidden = false;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();

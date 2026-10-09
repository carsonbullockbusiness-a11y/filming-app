// Pure helpers shared by the app and the Node tests. No DOM access here.
export const APP_VERSION = '0.3.1';
export const TZ = 'America/Los_Angeles';
export const BRANDS = ['Higgsfield', 'Whop', 'CapCut', 'Composio', 'Makon', 'Strawberry', 'Amboras', 'Teamily', 'FOMO', 'Cheetah', 'Polsia', 'Replit'];
export const PARTS = ['HOOK', 'INSERT', 'DEMO', 'CTA'];
export const PART_LABELS = { HOOK: 'Hook', INSERT: 'Insert', DEMO: 'Demo', CTA: 'CTA', REF: 'Ref' };
// Videos per day from /workspace/ops/posting-kpi.md (2026-10-08). Unknown brands get 1.
export const DAILY_TARGETS = {
  Higgsfield: 5, FOMO: 3, Teamily: 3, Strawberry: 3, Makon: 2, Polsia: 2,
  Composio: 1, Whop: 1, Amboras: 1, CapCut: 0, Cheetah: 1, Replit: 1
};
export const MAX_VIDEOS = 50;
// Exposure (EV) remembered per part. Demo defaults darker so laptop/phone screens are readable.
export const DEFAULT_EV = { HOOK: 0, INSERT: 0, DEMO: -0.7, CTA: 0 };
// Quality presets. Width/height are requested as "ideal" (landscape sensor order; the phone rotates for portrait).
export const QUALITIES = {
  '720': { w: 1280, h: 720, fps: 30, bits: 5e6, label: '720p · 30fps (smallest)' },
  '1080': { w: 1920, h: 1080, fps: 30, bits: 12e6, label: '1080p · 30fps' },
  '1080-60': { w: 1920, h: 1080, fps: 60, bits: 20e6, label: '1080p · 60fps' },
  '4k': { w: 3840, h: 2160, fps: 30, bits: 45e6, label: '4K · 30fps' },
  '4k-60': { w: 3840, h: 2160, fps: 60, bits: 65e6, label: '4K · 60fps' }
};
export const CHUNK_BYTES = 4 * 1024 * 1024; // must match a multiple of 256 KB (server accepts any such size)

function ptParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23'
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}

/** '2026-10-08' in Pacific time */
export function ptDayKey(d = new Date()) {
  const p = ptParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** '2026-10-08 Thu' (matches the Drive day-folder naming) */
export function ptDayFolderName(d = new Date()) {
  const p = ptParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.weekday}`;
}

/** '143205' (HHmmss, Pacific) */
export function ptTimeToken(d = new Date()) {
  const p = ptParts(d);
  return `${p.hour}${p.minute}${p.second}`;
}

/** '2:32 PM' */
export function ptClock(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
}

export function brandToken(b) {
  return String(b || '').replace(/[^A-Za-z0-9]/g, '') || 'Brand';
}

export function extForMime(m, origName) {
  const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(String(origName || ''));
  if (fromName) return fromName[1].toLowerCase();
  m = String(m || '').toLowerCase();
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('webm')) return 'webm';
  if (m.startsWith('image/jpeg')) return 'jpg';
  if (m.startsWith('image/')) return m.split('/')[1].split(';')[0].replace(/[^a-z0-9]/g, '') || 'img';
  return 'mp4';
}

/** Predicted Drive filename, e.g. HOOK_Higgsfield_V2_143205.mp4 (server makes the final, unique name). */
export function clipName(part, brand, date, mime, origName, video) {
  return `${part}_${brandToken(brand)}${video ? '_V' + video : ''}_${ptTimeToken(date)}.${extForMime(mime, origName)}`;
}

/* ---------------- days + video folders ---------------- */
export function dailyTarget(brand) {
  return Object.prototype.hasOwnProperty.call(DAILY_TARGETS, brand) ? DAILY_TARGETS[brand] : 1;
}

export function isDayKey(k) { return /^\d{4}-\d{2}-\d{2}$/.test(String(k || '')); }

/** '2026-10-09' -> '2026-10-09 Fri' (the Drive day-folder name) */
export function dayKeyToFolderName(key) {
  const [y, m, d] = key.split('-').map(Number);
  return ptDayFolderName(new Date(Date.UTC(y, m - 1, d, 19, 0, 0))); // noon-ish Pacific
}

/** '2026-10-09' +/- days */
export function shiftDayKey(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  return ptDayKey(new Date(Date.UTC(y, m - 1, d + delta, 19, 0, 0)));
}

/** 'Fri Oct 9' */
export function dayKeyLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function videoFolderName(k) { return 'Video ' + k; }

export function parseVideoFolderName(name) {
  const m = /^Video (\d{1,2})$/.exec(String(name || '').trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= MAX_VIDEOS ? n : 0;
}

/** Video numbers to show: 1..max(target, highest folder on Drive, highest local). */
export function videoNumbers(target, serverNums = [], localMax = 0) {
  const n = Math.min(MAX_VIDEOS, Math.max(Number(target) || 0, Number(localMax) || 0, ...serverNums.map(Number).filter((x) => x > 0)));
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** Merge one video's server copy into the local copy. Local unsaved edits (dirty) win for notes/links. */
export function mergeVideo(local, server) {
  const out = Object.assign({ refLinks: [], notes: '', ready: false, readyAt: null, clips: [], files: [], dirty: false }, local || {});
  if (!server) return out;
  out.clips = server.clips || [];
  out.files = server.files || [];
  out.folderId = server.folderId || out.folderId;
  out.folderUrl = server.folderUrl || out.folderUrl;
  out.ready = !!server.ready;
  out.readyAt = server.readyAt || null;
  out.serverUpdatedAt = server.updatedAt || null;
  if (!out.dirty) {
    out.refLinks = server.refLinks || [];
    out.notes = server.notes || '';
  }
  return out;
}

/** Clips on this device that still need to upload for one video folder. */
export function pendingForVideo(clips, brand, day, video) {
  return clips.filter((c) => c.brand === brand && c.day === day && Number(c.video) === Number(video) && c.status !== 'done');
}

/* ---------------- reference links ---------------- */
export function extractUrls(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const u = m[0].replace(/[),.;!?]+$/, '');
    if (isHttpUrl(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

export function refLabel(url) {
  let h = '';
  try { h = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'Link'; }
  if (/tiktok\.com$/.test(h)) return 'TikTok';
  if (/instagram\.com$/.test(h)) return 'Instagram';
  if (/notion\.(so|site)$/.test(h)) return 'Notion';
  if (/youtube\.com$|youtu\.be$/.test(h)) return 'YouTube';
  if (/(^|\.)x\.com$|twitter\.com$/.test(h)) return 'X';
  if (/drive\.google\.com$|docs\.google\.com$/.test(h)) return 'Google';
  return h || 'Link';
}

/* ---------------- camera quality ---------------- */
export function qualityOf(key) { return QUALITIES[key] || QUALITIES['1080']; }

export function videoConstraints(key, facing, deviceId) {
  const q = qualityOf(key);
  const v = { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps } };
  if (deviceId) v.deviceId = { exact: deviceId };
  else v.facingMode = { ideal: facing };
  return v;
}

/** '4K · 60fps', '1080p · 30fps' from the size the camera actually gave us. */
export function resLabel(w, h, fps) {
  const short = Math.min(Number(w) || 0, Number(h) || 0);
  const name = short >= 2000 ? '4K' : short >= 1400 ? '1440p' : short >= 1000 ? '1080p' : short >= 700 ? '720p' : short ? short + 'p' : '?';
  return `${name} · ${Math.round(Number(fps) || 30)}fps`;
}

/* ---------------- exposure ---------------- */
/** Reads MediaTrackCapabilities. Supported only if the browser exposes an exposureCompensation range. */
export function exposureSupport(caps) {
  const c = (caps && caps.exposureCompensation) || null;
  const modes = (caps && Array.isArray(caps.exposureMode)) ? caps.exposureMode : [];
  if (!c || typeof c.min !== 'number' || typeof c.max !== 'number' || c.max <= c.min) {
    return { supported: false, min: -2, max: 0, step: 0.1, modes };
  }
  return { supported: true, min: c.min, max: c.max, step: c.step > 0 ? c.step : 0.1, modes };
}

export function clampEv(ev, min, max, step) {
  const s = step > 0 ? step : 0.1;
  const v = Math.round(Math.max(min, Math.min(max, Number(ev) || 0)) / s) * s;
  return Math.round(Math.max(min, Math.min(max, v)) * 100) / 100;
}

/** Drag up = brighter, drag down = darker, like the iPhone camera. A full-height drag covers ~1.5x the range. */
export function evFromDrag(startEv, dyPx, heightPx, min, max, step) {
  const span = (max - min) * 1.5;
  return clampEv(startEv - (dyPx / Math.max(1, heightPx)) * span, min, max, step);
}

/** Darken fallback (canvas): opacity of a black layer that gives the same brightness as `ev` stops. */
export function evToDarkAlpha(ev) {
  const e = Number(ev) || 0;
  return e >= 0 ? 0 : Math.round((1 - Math.pow(2, e)) * 1000) / 1000;
}

export function fmtEv(ev) {
  const e = Math.round((Number(ev) || 0) * 10) / 10;
  return (e > 0 ? '+' : e < 0 ? '−' : '±') + Math.abs(e).toFixed(1);
}

/* ---------------- crash-safe recording ---------------- */
/** Puts recorded pieces back in order: pieces saved to IndexedDB plus any kept in memory after a failed save. */
export function orderParts(saved, mem) {
  const all = saved.map((p) => [p.seq, p.blob]);
  for (const [seq, blob] of (mem || new Map())) if (!all.some((x) => x[0] === seq)) all.push([seq, blob]);
  return all.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

export const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

export function pickMimeType(isSupported) {
  for (const m of MIME_CANDIDATES) {
    try { if (isSupported(m)) return m; } catch (e) { /* keep looking */ }
  }
  return '';
}

function b64urlToB64(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return s;
}

export function encodeSetup(url, key) {
  return btoa(JSON.stringify({ u: url, k: key })).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Parses the '#setup=...' value made by showSetupLink() in Code.gs. Returns {url, key} or null. */
export function decodeSetup(s) {
  try {
    const o = JSON.parse(atob(b64urlToB64(s)));
    if (o && /^https:\/\/script\.google(usercontent)?\.com\//.test(o.u) && /^[A-Za-z0-9]{16,128}$/.test(o.k)) return { url: o.u, key: o.k };
  } catch (e) { /* invalid */ }
  return null;
}

export function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Ring light color. warmth 0 (cool blue-white) .. 100 (warm amber); bright 10..100 */
export function ringColor(warmth, bright) {
  const cool = [200, 225, 255], white = [255, 255, 255], warm = [255, 205, 150];
  const t = Math.max(0, Math.min(100, Number(warmth))) / 100;
  const a = t < 0.5 ? cool : white, b = t < 0.5 ? white : warm, k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const f = Math.max(10, Math.min(100, Number(bright))) / 100;
  const c = a.map((v, i) => Math.round((v + (b[i] - v) * k) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function isHttpUrl(u) {
  return /^https?:\/\/\S+\.\S+/i.test(String(u || '').trim());
}

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

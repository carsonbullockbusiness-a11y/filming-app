// Pure helpers shared by the app and the Node tests. No DOM access here.
export const APP_VERSION = '0.1.0';
export const TZ = 'America/Los_Angeles';
export const BRANDS = ['Higgsfield', 'Whop', 'CapCut', 'Composio', 'Makon', 'Strawberry', 'Amboras', 'Teamily', 'FOMO', 'Cheetah', 'Polsia', 'Replit'];
export const PARTS = ['HOOK', 'DEMO', 'CTA'];
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

/** Predicted Drive filename, e.g. HOOK_Higgsfield_143205.mp4 (server makes the final, unique name). */
export function clipName(part, brand, date, mime, origName) {
  return `${part}_${brandToken(brand)}_${ptTimeToken(date)}.${extForMime(mime, origName)}`;
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

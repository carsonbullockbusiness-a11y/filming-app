// Multi-segment takes (TikTok-style: record, pause, record, delete the last part, finish).
// Pure logic, no DOM, so the Node tests can check it. The app keeps one "take" at a time:
//   { id, brand, video, day, part, startedAt, segs: [{ id, startedAt, durationSec, mime, ... }] }
// Each finished segment's video lives in IndexedDB (blobStore, key = seg.id) until the take is
// finished (joined into one clip) or the segment is deleted. Deleted segments are never uploaded.

export const DELETE_CONFIRM_MS = 3000;

export function newTake(o) {
  return {
    id: o.id, brand: o.brand, video: o.video || null, day: o.day || null, part: o.part || 'HOOK',
    startedAt: o.startedAt || Date.now(), segs: []
  };
}

/** Seconds recorded in the finished segments (plus the one being recorded right now). */
export function takeTotal(take, liveSec = 0) {
  const done = take ? take.segs.reduce((n, s) => n + (Number(s.durationSec) || 0), 0) : 0;
  return Math.round((done + (Number(liveSec) || 0)) * 10) / 10;
}

export function addSegment(take, seg) {
  take.segs.push(seg);
  return take;
}

/** Removes the newest segment and returns it (or null when the take is empty). */
export function removeLastSegment(take) {
  return take && take.segs.length ? take.segs.pop() : null;
}

/**
 * Two-tap delete like TikTok: the first tap arms (last segment turns red), a second tap within
 * DELETE_CONFIRM_MS deletes. Returns { action: 'arm' | 'delete', armedAt }.
 */
export function deleteTap(armedAt, now, ms = DELETE_CONFIRM_MS) {
  if (armedAt && now - armedAt <= ms) return { action: 'delete', armedAt: 0 };
  return { action: 'arm', armedAt: now };
}

/** Length the progress bar represents: the auto-stop limit, or a scale that grows with the take. */
export function barScale(maxLen, totalSec) {
  if (maxLen > 0) return maxLen;
  if (totalSec < 50) return 60;
  return Math.ceil((totalSec + 10) / 60) * 60;
}

/**
 * Progress bar pieces in percent of the bar: one per finished segment, plus the live one.
 * Ticks (the gaps between segments) are the `left` of every piece after the first.
 */
export function barLayout(segs, liveSec, scaleSec) {
  const out = [];
  let at = 0;
  const pct = (s) => Math.max(0, (Number(s) || 0) / scaleSec * 100);
  for (const s of segs) {
    const w = Math.min(pct(s.durationSec), Math.max(0, 100 - at));
    out.push({ left: at, width: w, live: false });
    at += w;
  }
  if (liveSec != null && liveSec >= 0) out.push({ left: at, width: Math.min(pct(liveSec), Math.max(0, 100 - at)), live: true });
  return out;
}

/** '6.0s' under a minute, '1:05' above. */
export function fmtTake(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return s.toFixed(1) + 's';
  const r = Math.floor(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}

/** Seconds left before auto-stop (Infinity when there is no limit). */
export function timeLeft(maxLen, totalSec) {
  return maxLen > 0 ? Math.max(0, maxLen - totalSec) : Infinity;
}

/**
 * Fallback when the phone can't join the segments into one file: each kept segment becomes its
 * own clip. Their recordedAt values are forced to be at least 1 s apart and increasing, so the
 * receiver's HHmmss file names sort in filming order, and each note tells the editor to join them.
 */
export function segmentClipPlan(take, timeToken) {
  const n = take.segs.length;
  const tag = timeToken(new Date(take.startedAt));
  let prev = 0;
  return take.segs.map((s, i) => {
    let at = Math.max(Number(s.startedAt) || take.startedAt, take.startedAt);
    if (prev && at < prev + 1000) at = prev + 1000;
    prev = at;
    return {
      segId: s.id, recordedAt: at, index: i + 1, count: n, takeTag: tag,
      note: `[JOIN: take ${tag}, segment ${i + 1} of ${n}. Concatenate segments 1-${n} in order into one ${take.part} clip.]`
    };
  });
}

/** True when a segment note made by segmentClipPlan is at the start of a clip note. */
export const SEG_NOTE_RE = /^\[JOIN: take \d{6}, segment \d+ of \d+\.[^\]]*\]\s*/;

/** Keeps the JOIN instruction and appends Carson's own note. */
export function mergeSegNote(existing, userNote) {
  const m = SEG_NOTE_RE.exec(String(existing || ''));
  const u = String(userNote || '').trim();
  return m ? (m[0].trim() + (u ? ' ' + u : '')) : u;
}

/** Strips the JOIN instruction so the review box shows only Carson's note. */
export function userPartOfNote(note) {
  return String(note || '').replace(SEG_NOTE_RE, '');
}

/** Drops segments whose video is gone from storage (e.g. storage was cleared). */
export function pruneMissing(take, haveIds) {
  const have = new Set(haveIds);
  const before = take.segs.length;
  take.segs = take.segs.filter((s) => have.has(s.id));
  return before - take.segs.length;
}

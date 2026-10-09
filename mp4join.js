// Lossless join of fragmented-MP4 recordings (what MediaRecorder writes on iOS Safari and Chrome).
// Each pause/resume in the camera makes its own short recording ("segment"). To hand the editor ONE
// clip, we keep segment 1's header (ftyp + moov) and append every segment's moof+mdat fragments,
// renumbering the fragments and shifting their timestamps (tfdt) so they play back to back.
// No re-encoding, no quality loss, and the big mdat payloads are never copied into memory:
// the result is a Blob made of slices of the original Blobs plus a few patched header boxes.
// If the segments can't be joined safely (not fragmented, WebM, different camera/resolution/codec
// settings), joinFmp4 throws and the app uploads the segments separately for the editor to join.

const DROP_TOP = new Set(['styp', 'sidx', 'mfra', 'free', 'skip', 'wide', 'uuid', 'prft', 'emsg', 'meta', 'udta']);

export class JoinError extends Error {}

const typeAt = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

async function bytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Top-level boxes of a Blob, reading only the box headers. */
export async function topBoxes(blob) {
  const out = [];
  const n = blob.size;
  let off = 0;
  while (off + 8 <= n) {
    const h = await bytes(blob, off, Math.min(n, off + 16));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = typeAt(h, 4);
    let hdr = 8;
    if (size === 1) {
      if (h.length < 16) { out.push({ type, start: off, size: n - off, hdr, truncated: true }); break; }
      size = Number(dv.getBigUint64(8));
      hdr = 16;
    } else if (size === 0) size = n - off;
    if (size < hdr || off + size > n) { out.push({ type, start: off, size: n - off, hdr, truncated: true }); break; }
    out.push({ type, start: off, size, hdr });
    off += size;
  }
  return out;
}

/** Child boxes inside a box that is held in memory (u8). */
function kids(u8, start, end) {
  const out = [];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) throw new JoinError('bad box inside ' + typeAt(u8, p));
    out.push({ type: typeAt(u8, p + 4), start: p, size, hdr, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const find = (list, t) => list.find((b) => b.type === t);
function walk(u8, box, path) {
  let cur = box;
  for (const t of path) {
    if (!cur) return null;
    cur = find(kids(u8, cur.body, cur.end), t);
  }
  return cur;
}

function readUint(dv, p, big) { return big ? Number(dv.getBigUint64(p)) : dv.getUint32(p); }
function writeUint(dv, p, big, v) {
  if (big) dv.setBigUint64(p, BigInt(Math.max(0, Math.round(v))));
  else {
    if (v > 0xffffffff || v < 0) throw new JoinError('value out of range');
    dv.setUint32(p, Math.round(v));
  }
}

/** moov: tracks (id -> timescale, handler, stsd bytes, trex default duration) + movie timescale. */
function parseMoov(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const moov = kids(u8, 0, u8.length)[0];
  if (!moov || moov.type !== 'moov') throw new JoinError('no moov');
  const top = kids(u8, moov.body, moov.end);
  const mvhd = find(top, 'mvhd');
  if (!mvhd) throw new JoinError('no mvhd');
  const mv1 = u8[mvhd.body] === 1;
  const movieTs = dv.getUint32(mvhd.body + (mv1 ? 20 : 12));
  const mvex = find(top, 'mvex');
  if (!mvex) throw new JoinError('not a fragmented MP4 (no mvex)');
  const trex = new Map();
  for (const b of kids(u8, mvex.body, mvex.end)) {
    if (b.type === 'trex') trex.set(dv.getUint32(b.body + 4), dv.getUint32(b.body + 12));
  }
  const tracks = new Map();
  for (const tr of top.filter((b) => b.type === 'trak')) {
    const tkhd = walk(u8, tr, ['tkhd']);
    const id = dv.getUint32(tkhd.body + (u8[tkhd.body] === 1 ? 20 : 12));
    const mdhd = walk(u8, tr, ['mdia', 'mdhd']);
    const ts = dv.getUint32(mdhd.body + (u8[mdhd.body] === 1 ? 20 : 12));
    const hdlr = walk(u8, tr, ['mdia', 'hdlr']);
    const stsd = walk(u8, tr, ['mdia', 'minf', 'stbl', 'stsd']);
    tracks.set(id, {
      id, ts, handler: hdlr ? typeAt(u8, hdlr.body + 8) : '',
      stsd: stsd ? Array.from(u8.subarray(stsd.start, stsd.end)).join(',') : '',
      trexDur: trex.get(id) || 0
    });
  }
  if (!tracks.size) throw new JoinError('no tracks');
  return { tracks, movieTs };
}

/** moof: traf list with where tfdt / base_data_offset live, and each traf's total sample duration. */
function parseMoof(u8, tracks) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const moof = kids(u8, 0, u8.length)[0];
  const top = kids(u8, moof.body, moof.end);
  const mfhd = find(top, 'mfhd');
  if (!mfhd) throw new JoinError('no mfhd');
  const trafs = [];
  for (const tf of top.filter((b) => b.type === 'traf')) {
    const k = kids(u8, tf.body, tf.end);
    const tfhd = find(k, 'tfhd');
    const tfdt = find(k, 'tfdt');
    if (!tfhd || !tfdt) throw new JoinError('fragment without tfhd/tfdt');
    const flags = dv.getUint32(tfhd.body) & 0xffffff;
    const id = dv.getUint32(tfhd.body + 4);
    let p = tfhd.body + 8;
    let basePos = -1;
    if (flags & 0x1) { basePos = p; p += 8; }
    if (flags & 0x2) p += 4;
    let defDur = (tracks.get(id) || {}).trexDur || 0;
    if (flags & 0x8) defDur = dv.getUint32(p);
    const big = u8[tfdt.body] === 1;
    let dur = 0;
    for (const tr of k.filter((b) => b.type === 'trun')) {
      const tfl = dv.getUint32(tr.body) & 0xffffff;
      const count = dv.getUint32(tr.body + 4);
      let q = tr.body + 8;
      if (tfl & 0x1) q += 4;
      if (tfl & 0x4) q += 4;
      const per = ((tfl & 0x100) ? 4 : 0) + ((tfl & 0x200) ? 4 : 0) + ((tfl & 0x400) ? 4 : 0) + ((tfl & 0x800) ? 4 : 0);
      if (q + per * count > tr.end) throw new JoinError('trun too short');
      if (tfl & 0x100) for (let i = 0; i < count; i++) dur += dv.getUint32(q + i * per);
      else dur += defDur * count;
    }
    trafs.push({ id, tfdtPos: tfdt.body + 4, big, tfdt: readUint(dv, tfdt.body + 4, big), dur, basePos });
  }
  return { seqPos: mfhd.body + 4, trafs };
}

/** Reads one recording: header, fragments (moof + following mdat) and each track's time span. */
export async function analyzeFmp4(blob) {
  const boxes = await topBoxes(blob);
  const ftyp = boxes.find((b) => b.type === 'ftyp' && !b.truncated);
  const moovBox = boxes.find((b) => b.type === 'moov' && !b.truncated);
  if (!ftyp || !moovBox) throw new JoinError('missing ftyp/moov');
  const moov = await bytes(blob, moovBox.start, moovBox.start + moovBox.size);
  const { tracks, movieTs } = parseMoov(moov);
  const frags = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.type === 'moof') {
      const m = boxes[i + 1];
      if (b.truncated || !m || m.type !== 'mdat' || m.truncated) break; // cut off by a crash: keep what's complete
      const u8 = await bytes(blob, b.start, b.start + b.size);
      frags.push({ start: b.start, moof: u8, info: parseMoof(u8, tracks), mdat: m });
      i++;
    } else if (b.type === 'mdat') {
      throw new JoinError('sample data outside a fragment (not a fragmented recording)');
    } else if (b.type !== 'ftyp' && b.type !== 'moov' && !DROP_TOP.has(b.type) && !b.truncated) {
      throw new JoinError('unexpected box ' + b.type);
    }
  }
  const start = new Map();
  const end = new Map();
  for (const f of frags) {
    for (const t of f.info.trafs) {
      if (!tracks.has(t.id)) throw new JoinError('fragment for unknown track');
      start.set(t.id, Math.min(start.has(t.id) ? start.get(t.id) : Infinity, t.tfdt));
      end.set(t.id, Math.max(end.get(t.id) || 0, t.tfdt + t.dur));
    }
  }
  let seconds = 0;
  for (const [id, s] of start) seconds = Math.max(seconds, (end.get(id) - s) / tracks.get(id).ts);
  return { blob, ftyp, moovBox, moov, tracks, movieTs, frags, start, end, seconds };
}

/** Length in seconds of a fragmented MP4 recording (used for takes recovered after a crash). */
export async function fmp4Duration(blob) {
  try { return (await analyzeFmp4(blob)).seconds; } catch (e) { return null; }
}

function sameTracks(a, b) {
  if (a.tracks.size !== b.tracks.size) return 'different track count';
  for (const [id, t] of a.tracks) {
    const u = b.tracks.get(id);
    if (!u) return 'different track ids';
    if (u.ts !== t.ts || u.handler !== t.handler) return 'different track timing';
    if (u.stsd !== t.stsd) return 'different camera/codec settings (' + t.handler + ')';
  }
  return '';
}

/** Rewrites duration fields in the copied moov so players show the full length. */
function patchMoovDurations(moov, movieTs, tracks, totalSec) {
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root = kids(moov, 0, moov.length)[0];
  const top = kids(moov, root.body, root.end);
  const setIfSet = (pos, big, val) => { if (readUint(dv, pos, big) > 0) writeUint(dv, pos, big, val); };
  const mvhd = find(top, 'mvhd');
  const mv1 = moov[mvhd.body] === 1;
  setIfSet(mvhd.body + (mv1 ? 24 : 16), mv1, totalSec * movieTs);
  const mvex = find(top, 'mvex');
  const mehd = mvex && find(kids(moov, mvex.body, mvex.end), 'mehd');
  if (mehd) writeUint(dv, mehd.body + 4, moov[mehd.body] === 1, totalSec * movieTs);
  for (const tr of top.filter((b) => b.type === 'trak')) {
    const tkhd = walk(moov, tr, ['tkhd']);
    const t1 = moov[tkhd.body] === 1;
    setIfSet(tkhd.body + (t1 ? 28 : 20), t1, totalSec * movieTs);
    const id = dv.getUint32(tkhd.body + (t1 ? 20 : 12));
    const mdhd = walk(moov, tr, ['mdia', 'mdhd']);
    const m1 = moov[mdhd.body] === 1;
    setIfSet(mdhd.body + (m1 ? 24 : 16), m1, totalSec * tracks.get(id).ts);
    const elst = walk(moov, tr, ['edts', 'elst']);
    if (elst) {
      const e1 = moov[elst.body] === 1;
      const n = dv.getUint32(elst.body + 4);
      const w = e1 ? 20 : 12;
      let used = 0;
      for (let i = 0; i < n; i++) {
        const p = elst.body + 8 + i * w;
        const segDur = readUint(dv, p, e1);
        const mediaTime = e1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
        if (i === n - 1 && mediaTime !== -1 && segDur > 0) writeUint(dv, p, e1, Math.max(0, totalSec * movieTs - used));
        else used += segDur;
      }
    }
  }
}

/**
 * Joins fragmented-MP4 recordings into one Blob. Throws JoinError when they can't be joined safely.
 * Returns { blob, seconds, fragments }.
 */
export async function joinFmp4(blobs, type = 'video/mp4') {
  if (!blobs.length) throw new JoinError('nothing to join');
  const segs = [];
  for (const b of blobs) segs.push(await analyzeFmp4(b));
  const first = segs[0];
  for (const s of segs.slice(1)) {
    const why = sameTracks(first, s);
    if (why) throw new JoinError(why);
  }
  const used = segs.filter((s) => s.frags.length);
  if (!used.length) throw new JoinError('no video data');
  const total = used.reduce((n, s) => n + s.seconds, 0);
  const moov = first.moov.slice();
  patchMoovDurations(moov, first.movieTs, first.tracks, total);
  const parts = [first.blob.slice(first.ftyp.start, first.ftyp.start + first.ftyp.size), moov];
  let outPos = first.ftyp.size + moov.length;
  const base = new Map();
  for (const [id] of first.tracks) {
    const s = used.find((x) => x.start.has(id));
    base.set(id, s ? s.start.get(id) : 0);
  }
  let seq = 1;
  let cum = 0;
  let fragments = 0;
  for (const s of used) {
    const shift = new Map();
    for (const [id, t] of first.tracks) shift.set(id, Math.round(cum * t.ts) + base.get(id) - (s.start.has(id) ? s.start.get(id) : 0));
    for (const f of s.frags) {
      const u8 = f.moof.slice();
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      dv.setUint32(f.info.seqPos, seq++);
      for (const t of f.info.trafs) {
        writeUint(dv, t.tfdtPos, t.big, t.tfdt + shift.get(t.id));
        if (t.basePos >= 0) {
          const old = dv.getBigUint64(t.basePos);
          dv.setBigUint64(t.basePos, old + BigInt(outPos - f.start));
        }
      }
      parts.push(u8, s.blob.slice(f.mdat.start, f.mdat.start + f.mdat.size));
      outPos += u8.length + f.mdat.size;
      fragments++;
    }
    cum += s.seconds;
  }
  return { blob: new Blob(parts, { type }), seconds: total, fragments };
}

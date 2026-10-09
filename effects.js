// Green screen / background blur.
// Person cut-out: MediaPipe Selfie Segmenter (tasks-vision, loaded from CDN only when first used).
// Fallback / "Green" mode: classic chroma key for a real green backdrop.
// Output: a <canvas> we draw every camera frame into; recording uses canvas.captureStream().

const TV_VERSION = '0.10.17';
const TV_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const MAX_SIDE = 1920; // cap the composited canvas at 1080x1920

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function mk(w = 2, h = 2, opts) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', opts)];
}

export class Compositor {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'off'; // off | blur | image | chroma
    this.bg = null; // HTMLImageElement or HTMLVideoElement
    this.bgUrl = null;
    this.seg = null;
    this.segLoading = null;
    this.segFailed = false;
    this.running = false;
    this.hasMask = false;
    this.chroma = { min: 25, max: 70 };
    [this.person, this.pctx] = mk();
    [this.mask, this.mctx] = mk();
    [this.small, this.sctx] = mk(2, 2, { willReadFrequently: true });
    [this.blur1, this.b1ctx] = mk();
    [this.blur2, this.b2ctx] = mk();
    this.prev = null;
    this.maskImg = null;
    this.onStatus = () => {};
    this.lastSegMs = 0;
    this.frameCb = this.frame.bind(this);
  }

  get active() { return this.mode !== 'off'; }

  get canRecord() { return typeof this.canvas.captureStream === 'function'; }

  async setMode(mode) {
    this.mode = mode;
    this.hasMask = false;
    this.prev = null;
    this.maskImg = null;
    if (mode === 'off') { this.stop(); return; }
    this.start();
    if (mode === 'blur' || mode === 'image') await this.ensureSegmenter();
  }

  async setBackground(blob) {
    if (this.bgUrl) URL.revokeObjectURL(this.bgUrl);
    if (this.bg && this.bg.pause) this.bg.pause();
    this.bg = null;
    this.bgUrl = null;
    if (!blob) return;
    this.bgUrl = URL.createObjectURL(blob);
    if ((blob.type || '').startsWith('video/')) {
      const v = document.createElement('video');
      Object.assign(v, { muted: true, loop: true, playsInline: true, autoplay: true, src: this.bgUrl });
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      await v.play().catch(() => {});
      this.bg = v;
    } else {
      const img = new Image();
      img.src = this.bgUrl;
      await img.decode().catch(() => {});
      this.bg = img;
    }
  }

  ensureSegmenter() {
    if (this.seg || this.segFailed) return Promise.resolve(this.seg);
    if (this.segLoading) return this.segLoading;
    this.onStatus('Loading cut-out model (first time only)…');
    this.segLoading = (async () => {
      try {
        const { FilesetResolver, ImageSegmenter } = await import(`${TV_BASE}/vision_bundle.mjs`);
        const fileset = await FilesetResolver.forVisionTasks(`${TV_BASE}/wasm`);
        const make = (delegate) => ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false
        });
        try {
          this.seg = await make(isIOS() ? 'CPU' : 'GPU');
        } catch (e) {
          this.seg = await make('CPU');
        }
        this.onStatus('');
      } catch (e) {
        console.warn('Segmenter failed', e);
        this.segFailed = true;
        this.onStatus('Cut-out model did not load (offline?). Use "Green" with a real green backdrop.');
      }
      return this.seg;
    })();
    return this.segLoading;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop() { this.running = false; }

  schedule() {
    if (!this.running) return;
    const v = this.video;
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(this.frameCb);
    else requestAnimationFrame(this.frameCb);
  }

  frame() {
    if (!this.running) return;
    try { this.draw(); } catch (e) { console.warn(e); }
    this.schedule();
  }

  resize(vw, vh) {
    const s = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    const W = Math.round(vw * s), H = Math.round(vh * s);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
      this.person.width = W; this.person.height = H;
      this.blur1.width = Math.max(2, Math.round(W / 24)); this.blur1.height = Math.max(2, Math.round(H / 24));
      this.blur2.width = Math.max(2, Math.round(W / 6)); this.blur2.height = Math.max(2, Math.round(H / 6));
    }
    return [W, H];
  }

  draw() {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    const [W, H] = this.resize(v.videoWidth, v.videoHeight);
    const ctx = this.ctx;

    if (this.mode === 'chroma') this.chromaMask(v);
    else if (this.seg) this.segMask(v);

    if (!this.hasMask) { ctx.drawImage(v, 0, 0, W, H); return; }

    // 1) background
    if ((this.mode === 'image' || this.mode === 'chroma') && this.bg) this.drawCover(this.bg, W, H);
    else if (this.mode === 'chroma') { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H); }
    else this.drawBlur(v, W, H);

    // 2) person on top
    const p = this.pctx;
    p.globalCompositeOperation = 'copy';
    p.drawImage(v, 0, 0, W, H);
    p.globalCompositeOperation = 'destination-in';
    p.imageSmoothingEnabled = true;
    p.drawImage(this.mask, 0, 0, W, H);
    p.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.person, 0, 0);
  }

  drawBlur(v, W, H) {
    this.b1ctx.drawImage(v, 0, 0, this.blur1.width, this.blur1.height);
    this.b2ctx.imageSmoothingEnabled = true;
    this.b2ctx.drawImage(this.blur1, 0, 0, this.blur2.width, this.blur2.height);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.blur2, 0, 0, W, H);
  }

  drawCover(src, W, H) {
    const sw = src.videoWidth || src.naturalWidth || src.width;
    const sh = src.videoHeight || src.naturalHeight || src.height;
    if (!sw || !sh) { this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, W, H); return; }
    const s = Math.max(W / sw, H / sh);
    const dw = sw * s, dh = sh * s;
    this.ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  ensureMaskSize(mw, mh) {
    if (this.mask.width !== mw || this.mask.height !== mh || !this.maskImg) {
      this.mask.width = mw; this.mask.height = mh;
      this.maskImg = this.mctx.createImageData(mw, mh);
      const d = this.maskImg.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 0; }
      this.prev = new Float32Array(mw * mh);
    }
  }

  writeMask(alphaAt, n) {
    const d = this.maskImg.data, prev = this.prev;
    for (let i = 0; i < n; i++) {
      const a = prev[i] = prev[i] * 0.35 + alphaAt(i) * 0.65; // light temporal smoothing = less flicker
      d[i * 4 + 3] = a * 255;
    }
    this.mctx.putImageData(this.maskImg, 0, 0);
    this.hasMask = true;
  }

  segMask(v) {
    const t = performance.now();
    if (t <= this.lastSegMs) return;
    this.lastSegMs = t;
    this.seg.segmentForVideo(v, t, (result) => {
      const m = result && result.confidenceMasks && result.confidenceMasks[0];
      if (!m) return;
      const mw = m.width, mh = m.height, conf = m.getAsFloat32Array();
      this.ensureMaskSize(mw, mh);
      this.writeMask((i) => { const a = (conf[i] - 0.3) * 2.5; return a < 0 ? 0 : a > 1 ? 1 : a; }, mw * mh);
    });
  }

  chromaMask(v) {
    const mw = 180, mh = Math.max(2, Math.round(180 * v.videoHeight / v.videoWidth));
    if (this.small.width !== mw || this.small.height !== mh) { this.small.width = mw; this.small.height = mh; }
    this.sctx.drawImage(v, 0, 0, mw, mh);
    const px = this.sctx.getImageData(0, 0, mw, mh).data;
    this.ensureMaskSize(mw, mh);
    const { min, max } = this.chroma;
    this.writeMask((i) => {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const green = g - Math.max(r, b); // how "green-screen" this pixel is
      const k = (green - min) / (max - min);
      return k <= 0 ? 1 : k >= 1 ? 0 : 1 - k;
    }, mw * mh);
  }

  /** Video track of the composited canvas (for MediaRecorder). */
  captureTrack(fps = 30) {
    const s = this.canvas.captureStream(fps);
    return s.getVideoTracks()[0];
  }
}

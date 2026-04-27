const els = {
  fileInput: document.getElementById("fileInput"),
  regenBtn: document.getElementById("regenBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  resetZoomBtn: document.getElementById("resetZoomBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  audioSampleRate: document.getElementById("audioSampleRate"),
  fftSize: document.getElementById("fftSize"),
  colorMapSpec: document.getElementById("colorMapSpec"),
  colorMapVideo: document.getElementById("colorMapVideo"),
  videoDecodeW: document.getElementById("videoDecodeW"),
  videoSamplesPerSec: document.getElementById("videoSamplesPerSec"),
  video: document.getElementById("video"),
  status: document.getElementById("status"),
  videogram: document.getElementById("videogram"),
  spectrogram: document.getElementById("spectrogram"),
  downloadVideogramBtn: document.getElementById("downloadVideogramBtn"),
  downloadVideogramCsvBtn: document.getElementById("downloadVideogramCsvBtn"),
  downloadSpectrogramBtn: document.getElementById("downloadSpectrogramBtn"),
  downloadSpectrogramCsvBtn: document.getElementById("downloadSpectrogramCsvBtn"),
  selectionVideo: document.getElementById("selectionVideo"),
  selectionAudio: document.getElementById("selectionAudio"),
  playheadVideo: document.getElementById("playheadVideo"),
  playheadAudio: document.getElementById("playheadAudio"),
};

/** @type {string | null} */
let currentObjectUrl = null;
/** @type {File | null} */
let currentFile = null;

const STORAGE_KEY = "videoscrub.settings.v1";

const state = {
  // Time window (zoom). If null, use full duration.
  viewWindow: /** @type {{t0:number, t1:number} | null} */ (null),
  selection: /** @type {{t0:number, t1:number} | null} */ (null),
  // Raw data for CSV export (generated at sampling resolution, before scaling).
  videogram: /** @type {{cols:number, rows:number, t0:number, t1:number, data:Float32Array} | null} */ (null),
  spectrogram: /** @type {{cols:number, bins:number, sampleRate:number, fftSize:number, hopSize:number, t0:number, t1:number, mag:Float32Array} | null} */ (null),
};

const settings = {
  audioSampleRate: 11025,
  fftSize: 1024,
  colorMapSpec: "heat",
  colorMapVideo: "blueyellow",
  videoDecodeW: 128,
  videoSamplesPerSec: 6,
};

function setStatus(msg) {
  els.status.textContent = msg || "";
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    Object.assign(settings, parsed);
  } catch {
    // ignore
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

function applySettingsToUi() {
  if (els.audioSampleRate) els.audioSampleRate.value = String(settings.audioSampleRate);
  if (els.fftSize) els.fftSize.value = String(settings.fftSize);
  if (els.colorMapSpec) els.colorMapSpec.value = String(settings.colorMapSpec);
  if (els.colorMapVideo) els.colorMapVideo.value = String(settings.colorMapVideo);
  if (els.videoDecodeW) els.videoDecodeW.value = String(settings.videoDecodeW);
  if (els.videoSamplesPerSec) els.videoSamplesPerSec.value = String(settings.videoSamplesPerSec);
}

function readSettingsFromUi() {
  settings.audioSampleRate = Number.parseInt(els.audioSampleRate.value, 10) || 11025;
  settings.fftSize = Number.parseInt(els.fftSize.value, 10) || 1024;
  settings.colorMapSpec = els.colorMapSpec.value || "heat";
  settings.colorMapVideo = els.colorMapVideo.value || "blueyellow";
  settings.videoDecodeW = Math.max(32, Math.min(512, Number.parseInt(els.videoDecodeW.value, 10) || 128));
  settings.videoSamplesPerSec = Math.max(1, Math.min(30, Number.parseInt(els.videoSamplesPerSec.value, 10) || 6));
  saveSettings();
}

function setCanvasBackingStoreSize(canvas, cssHeight = 100) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { w, h, dpr };
}

function getEffectiveWindow() {
  const v = els.video;
  const duration = v.duration;
  if (!Number.isFinite(duration) || duration <= 0) return { t0: 0, t1: 1 };
  const vw = state.viewWindow;
  if (!vw) return { t0: 0, t1: duration };
  return { t0: Math.max(0, Math.min(duration, vw.t0)), t1: Math.max(0, Math.min(duration, vw.t1)) };
}

function drawPlaceholder(canvas, label) {
  setCanvasBackingStoreSize(canvas, 100);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#0f1620";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = `${Math.round(canvas.height * 0.22)}px ui-sans-serif, system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
}

function updatePlayheads() {
  const v = els.video;
  const duration = v.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const { t0, t1 } = getEffectiveWindow();
  const frac = clamp01((v.currentTime - t0) / Math.max(1e-6, t1 - t0));
  const set = (playhead, canvas) => {
    const wrap = canvas.parentElement;
    if (wrap) wrap.classList.add("hasMedia");
    playhead.style.left = `${frac * 100}%`;
  };
  set(els.playheadVideo, els.videogram);
  set(els.playheadAudio, els.spectrogram);
}

function hookCanvasSeekingAndSelection(canvas, selectionEl) {
  let drag = null;

  const updateSelectionEls = () => {
    const vw = getEffectiveWindow();
    const sel = state.selection;
    if (!sel) {
      selectionEl.hidden = true;
      els.resetZoomBtn.disabled = !state.viewWindow;
      return;
    }
    const a = clamp01((sel.t0 - vw.t0) / Math.max(1e-6, vw.t1 - vw.t0));
    const b = clamp01((sel.t1 - vw.t0) / Math.max(1e-6, vw.t1 - vw.t0));
    const x0 = Math.min(a, b) * 100;
    const x1 = Math.max(a, b) * 100;
    selectionEl.hidden = false;
    selectionEl.style.left = `${x0}%`;
    selectionEl.style.width = `${Math.max(0, x1 - x0)}%`;
    els.resetZoomBtn.disabled = !state.viewWindow;
  };

  const setSharedSelection = (t0, t1) => {
    state.selection = { t0: Math.min(t0, t1), t1: Math.max(t0, t1) };
    // Mirror selection across both canvases.
    updateSelectionOverlay();
  };

  const updateSelectionOverlay = () => {
    // Update both overlays from the shared selection.
    const vw = getEffectiveWindow();
    const sel = state.selection;
    const apply = (el) => {
      if (!sel) {
        el.hidden = true;
        return;
      }
      const a = clamp01((sel.t0 - vw.t0) / Math.max(1e-6, vw.t1 - vw.t0));
      const b = clamp01((sel.t1 - vw.t0) / Math.max(1e-6, vw.t1 - vw.t0));
      const x0 = Math.min(a, b) * 100;
      const x1 = Math.max(a, b) * 100;
      el.hidden = false;
      el.style.left = `${x0}%`;
      el.style.width = `${Math.max(0, x1 - x0)}%`;
    };
    apply(els.selectionVideo);
    apply(els.selectionAudio);
    els.resetZoomBtn.disabled = !state.viewWindow;
  };

  canvas.addEventListener("pointerdown", (e) => {
    const v = els.video;
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const r = canvas.getBoundingClientRect();
    const frac = clamp01((e.clientX - r.left) / r.width);
    const { t0, t1 } = getEffectiveWindow();
    const t = t0 + frac * (t1 - t0);

    // Shift+drag selects. Plain click seeks.
    if (e.shiftKey) {
      drag = { startT: t, pointerId: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
      setSharedSelection(t, t);
      updateSelectionEls();
      return;
    }

    v.currentTime = t;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const r = canvas.getBoundingClientRect();
    const frac = clamp01((e.clientX - r.left) / r.width);
    const { t0, t1 } = getEffectiveWindow();
    const t = t0 + frac * (t1 - t0);
    setSharedSelection(drag.startT, t);
  });

  canvas.addEventListener("pointerup", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag = null;
  });

  // Expose updater
  canvas._updateSelectionOverlay = updateSelectionOverlay;
}

function updateSelectionOverlay() {
  if (els.videogram?._updateSelectionOverlay) els.videogram._updateSelectionOverlay();
}

function downloadCanvasPng(canvas, filename) {
  const a = document.createElement("a");
  a.download = filename;
  a.href = canvas.toDataURL("image/png");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadTextFile(text, filename, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.download = filename;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

async function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onOk);
      target.removeEventListener("error", onErr);
    };
    target.addEventListener(eventName, onOk, { once: true });
    target.addEventListener("error", onErr, { once: true });
  });
}

async function waitForEventOrTimeout(target, eventName, timeoutMs) {
  return await Promise.race([
    waitForEvent(target, eventName),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function ensureVideoLoadedMetadata(videoEl) {
  if (Number.isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.videoWidth > 0) return;
  if (videoEl.readyState >= 1) return;
  await waitForEvent(videoEl, "loadedmetadata");
}

async function seekVideo(videoEl, t) {
  const target = Math.max(0, Math.min(t, (videoEl.duration || 0) - 1e-3));
  if (!Number.isFinite(target)) return;
  if (Math.abs(videoEl.currentTime - target) < 1e-4) return;
  // fastSeek can be significantly quicker in some browsers.
  if (typeof videoEl.fastSeek === "function") videoEl.fastSeek(target);
  else videoEl.currentTime = target;
  // Always wait for the seek to complete; readyState can already be >= 2 while a seek is still pending.
  await waitForEvent(videoEl, "seeked");
}

async function waitForFreshVideoFrame(videoEl, timeoutMs = 250) {
  // requestVideoFrameCallback gives a better guarantee that the decoded frame is ready after seek.
  if (typeof videoEl.requestVideoFrameCallback !== "function") return;
  await Promise.race([
    new Promise((resolve) => {
      videoEl.requestVideoFrameCallback(() => resolve());
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function makeTempCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function rowAveragesToBins(imageData, srcW, srcH, dstBins) {
  // Average luminance per source row, then downsample to dstBins.
  const data = imageData.data;
  const rowLum = new Float32Array(srcH);
  for (let y = 0; y < srcH; y++) {
    let sum = 0;
    const rowOff = y * srcW * 4;
    for (let x = 0; x < srcW; x++) {
      const i = rowOff + x * 4;
      // Rec.601-ish luma
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    rowLum[y] = sum / srcW;
  }

  const out = new Float32Array(dstBins);
  for (let b = 0; b < dstBins; b++) {
    const y0 = Math.floor((b * srcH) / dstBins);
    const y1 = Math.max(y0 + 1, Math.floor(((b + 1) * srcH) / dstBins));
    let s = 0;
    for (let y = y0; y < y1; y++) s += rowLum[y];
    out[b] = s / (y1 - y0);
  }
  return out;
}

async function generateVideogram({ videoEl, canvas, columns }) {
  await ensureVideoLoadedMetadata(videoEl);
  const duration = videoEl.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video duration unavailable.");

  const { w: outW, h: outH } = setCanvasBackingStoreSize(canvas, 100);
  const ctxOut = canvas.getContext("2d", { alpha: false });
  ctxOut.imageSmoothingEnabled = false;
  ctxOut.fillStyle = "#0f1620";
  ctxOut.fillRect(0, 0, outW, outH);

  // Choose how many time samples to take.
  // Goal: keep "frame count" correct (progress reflects actual samples) while skipping work for
  // long videos / very wide canvases (e.g. high-DPR screens).
  //
  // - Upper bound prevents hundreds/thousands of seeks on long files.
  // - Duration-based target keeps temporal detail roughly stable for long files.
  const { t0: win0, t1: win1 } = getEffectiveWindow();
  const windowDur = Math.max(1e-6, win1 - win0);

  const maxSamples = 900;
  const minSamples = 256;
  const samplesPerSecond = settings.videoSamplesPerSec; // lower = faster; visuals still readable at 100px tall
  const targetSamplesByDuration = Math.round(windowDur * samplesPerSecond);
  const desired = Math.max(minSamples, Math.min(maxSamples, targetSamplesByDuration));
  const colsToRender = Math.max(8, Math.min(columns ?? outW, outW, desired));

  // Draw each sampled time as a 1px (or scaled) column in output.
  // We only need row averages, so decode width can be quite small.
  const decodeW = settings.videoDecodeW;
  const decodeH = Math.round((decodeW * (videoEl.videoHeight || 180)) / (videoEl.videoWidth || 320));
  const temp = makeTempCanvas(decodeW, decodeH);
  const ctxTmp = temp.getContext("2d", { willReadFrequently: true });

  // Render at sampling resolution then scale to output width.
  const sampleCanvas = makeTempCanvas(colsToRender, outH);
  const ctxSample = sampleCanvas.getContext("2d", { alpha: false });
  ctxSample.imageSmoothingEnabled = false;
  ctxSample.fillStyle = "#0f1620";
  ctxSample.fillRect(0, 0, colsToRender, outH);

  const imgCol = ctxSample.createImageData(1, outH);
  const colData = imgCol.data;

  // Preserve prior playback state.
  const wasPaused = videoEl.paused;
  const priorTime = videoEl.currentTime;
  try {
    if (!wasPaused) videoEl.pause();

    const raw = new Float32Array(colsToRender * outH);

    for (let outX = 0; outX < colsToRender; outX++) {
      const t = win0 + (outX / Math.max(1, colsToRender - 1)) * windowDur;
      setStatus(`Generating videogram… ${outX + 1}/${colsToRender}`);
      await seekVideo(videoEl, t);
      await waitForFreshVideoFrame(videoEl);

      ctxTmp.drawImage(videoEl, 0, 0, decodeW, decodeH);
      const frame = ctxTmp.getImageData(0, 0, decodeW, decodeH);
      const bins = rowAveragesToBins(frame, decodeW, decodeH, outH);

      for (let y = 0; y < outH; y++) raw[outX * outH + y] = bins[y];

      // Map luminance to color
      for (let y = 0; y < outH; y++) {
        const v = clamp01(bins[y] / 255);
        const i = y * 4;
        let r, g, b;
        if (settings.colorMapVideo === "gray") {
          const c = Math.round(255 * v);
          r = c;
          g = c;
          b = c;
        } else {
          // blueyellow
          r = Math.round(255 * Math.pow(v, 0.85));
          g = Math.round(255 * Math.pow(v, 0.65));
          b = Math.round(255 * (0.25 + 0.75 * Math.pow(v, 0.9)));
        }
        colData[i] = r;
        colData[i + 1] = g;
        colData[i + 2] = b;
        colData[i + 3] = 255;
      }

      ctxSample.putImageData(imgCol, outX, 0);
    }

    state.videogram = { cols: colsToRender, rows: outH, t0: win0, t1: win1, data: raw };

    // Scale to full canvas width.
    ctxOut.clearRect(0, 0, outW, outH);
    ctxOut.drawImage(sampleCanvas, 0, 0, outW, outH);
  } finally {
    setStatus("");
    await seekVideo(videoEl, priorTime);
    if (!wasPaused) videoEl.play().catch(() => {});
  }
}

function hann(n, N) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
}

function createFftPlan(N) {
  // Precompute bit-reversal indices + twiddles for iterative Cooley–Tukey FFT.
  const rev = new Uint32Array(N);
  const log2N = Math.log2(N);
  for (let i = 0; i < N; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < log2N; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = y >>> 0;
  }

  const twiddles = [];
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const angStep = (-2 * Math.PI) / size;
    const cos = new Float32Array(half);
    const sin = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      const a = k * angStep;
      cos[k] = Math.cos(a);
      sin[k] = Math.sin(a);
    }
    twiddles.push({ size, half, cos, sin });
  }

  return { N, rev, twiddles, re: new Float32Array(N), im: new Float32Array(N) };
}

function fftMagOneSided({ samples, offset, window, plan, outMag }) {
  const { N, rev, twiddles, re, im } = plan;
  // Load + window into bit-reversed order.
  for (let i = 0; i < N; i++) {
    const s = samples[offset + i] ?? 0;
    const v = s * window[i];
    const j = rev[i];
    re[j] = v;
    im[j] = 0;
  }

  for (const stage of twiddles) {
    const { size, half, cos, sin } = stage;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const i0 = start + k;
        const i1 = i0 + half;
        const tr = re[i1] * cos[k] - im[i1] * sin[k];
        const ti = re[i1] * sin[k] + im[i1] * cos[k];
        re[i1] = re[i0] - tr;
        im[i1] = im[i0] - ti;
        re[i0] = re[i0] + tr;
        im[i0] = im[i0] + ti;
      }
    }
  }

  const bins = N / 2 + 1;
  for (let b = 0; b < bins; b++) {
    const r = re[b];
    const ii = im[b];
    outMag[b] = Math.sqrt(r * r + ii * ii);
  }
}

function stftMagnitudeSampled({ samples, fftSize, hopSize, sampleColumns }) {
  const N = fftSize;
  const H = hopSize;
  const bins = N / 2 + 1;
  const cols = sampleColumns;

  const window = new Float32Array(N);
  for (let i = 0; i < N; i++) window[i] = hann(i, N);

  const plan = createFftPlan(N);
  const mag = new Float32Array(cols * bins);
  const tmp = new Float32Array(bins);

  const maxFrame = Math.max(0, Math.floor((samples.length - N) / H));
  for (let x = 0; x < cols; x++) {
    const fx = x / Math.max(1, cols - 1);
    const frameIdx = Math.min(maxFrame, Math.max(0, Math.round(fx * maxFrame)));
    const off = frameIdx * H;
    fftMagOneSided({ samples, offset: off, window, plan, outMag: tmp });
    mag.set(tmp, x * bins);
  }

  return { mag, frames: cols, bins, fftSize, hopSize };
}

function mixToMono(audioBuffer) {
  const n = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < n; ch++) {
    const d = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += d[i] / n;
  }
  return out;
}

function renderSpectrogramToCanvas({ canvas, stft, widthPx }) {
  const { w: outW, h: outH } = setCanvasBackingStoreSize(canvas, 100);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;

  const targetW = Math.max(16, Math.min(widthPx ?? outW, outW));
  const img = ctx.createImageData(targetW, outH);
  const dst = img.data;

  const { mag, frames, bins } = stft;

  // Map output x to frame index, output y to frequency bin (log-ish).
  // y=0 top -> high freq, y=outH-1 bottom -> low freq
  const minBin = 1;
  const maxBin = bins - 1;
  const logMin = Math.log(minBin);
  const logMax = Math.log(maxBin);

  // Compute global reference for normalization (robust-ish via simple max).
  let maxMag = 1e-9;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];

  for (let x = 0; x < targetW; x++) {
    const fx = x / (targetW - 1);
    const frameIdx = Math.min(frames - 1, Math.max(0, Math.round(fx * (frames - 1))));
    const base = frameIdx * bins;

    for (let y = 0; y < outH; y++) {
      const fy = 1 - y / (outH - 1);
      const logBin = logMin + fy * (logMax - logMin);
      const b = Math.min(maxBin, Math.max(minBin, Math.round(Math.exp(logBin))));

      const m = mag[base + b] / maxMag;
      const db = 20 * Math.log10(m + 1e-6); // [-120..0]
      const v = clamp01((db + 80) / 80); // map [-80..0] -> [0..1]

      let r, g, bb;
      if (settings.colorMapSpec === "gray") {
        const c = Math.round(255 * v);
        r = c;
        g = c;
        bb = c;
      } else if (settings.colorMapSpec === "magma") {
        // lightweight "magma-ish" ramp
        r = Math.round(255 * Math.pow(v, 0.65));
        g = Math.round(180 * Math.pow(v, 1.2));
        bb = Math.round(255 * (0.08 + 0.92 * Math.pow(v, 1.8)));
      } else {
        // heat (default): dark -> purple -> orange -> white
        r = Math.round(255 * Math.pow(v, 0.85));
        g = Math.round(220 * Math.pow(v, 1.35));
        bb = Math.round(255 * (0.15 + 0.85 * Math.pow(v, 0.7)));
      }

      const i = (y * targetW + x) * 4;
      dst[i] = r;
      dst[i + 1] = g;
      dst[i + 2] = bb;
      dst[i + 3] = 255;
    }
  }

  // Paint to full canvas width (scale if needed).
  ctx.fillStyle = "#0f1620";
  ctx.fillRect(0, 0, outW, outH);

  if (targetW === outW) {
    ctx.putImageData(img, 0, 0);
  } else {
    // Put into a temp canvas then scale.
    const tmp = makeTempCanvas(targetW, outH);
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, outW, outH);
  }
}

async function decodeAudioFromFile(file) {
  const buf = await file.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await ac.decodeAudioData(buf.slice(0));
    return audioBuffer;
  } finally {
    ac.close().catch(() => {});
  }
}

async function downsampleAudioToMono(audioBuffer, targetSampleRate) {
  // Resample + mixdown using OfflineAudioContext (usually faster than processing full-rate data).
  const len = audioBuffer.length;
  const duration = len / audioBuffer.sampleRate;
  const outLen = Math.max(1, Math.floor(duration * targetSampleRate));
  const oac = new OfflineAudioContext(1, outLen, targetSampleRate);
  const src = oac.createBufferSource();
  src.buffer = audioBuffer;

  const gain = oac.createGain();
  gain.gain.value = 1 / Math.max(1, audioBuffer.numberOfChannels);

  // Mixdown: connect all channels into one gain node (they sum), then average by scaling gain.
  // This is typically plenty for visualization and avoids large JS loops.
  const splitter = oac.createChannelSplitter(audioBuffer.numberOfChannels);
  src.connect(splitter);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    splitter.connect(gain, ch, 0);
  }
  gain.connect(oac.destination);

  src.start(0);
  const rendered = await oac.startRendering();
  return { samples: rendered.getChannelData(0), sampleRate: rendered.sampleRate };
}

/** @type {{ audioCtx: AudioContext, src: MediaElementAudioSourceNode, analyser: AnalyserNode, freqDb: Float32Array } | null} */
let mediaAudioGraph = null;

async function ensureMediaAudioGraph(videoEl, fftSize = 2048) {
  if (mediaAudioGraph) return mediaAudioGraph;

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // File picker interaction should allow resume, but do it defensively.
  if (audioCtx.state !== "running") {
    try {
      await audioCtx.resume();
    } catch {
      // ignore; will fail later if user gesture is missing
    }
  }

  const src = audioCtx.createMediaElementSource(videoEl);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -10;

  // Route to destination so the graph actually runs. We'll mute the <video> element during sampling.
  src.connect(analyser);
  analyser.connect(audioCtx.destination);

  const freqDb = new Float32Array(analyser.frequencyBinCount);
  mediaAudioGraph = { audioCtx, src, analyser, freqDb };
  return mediaAudioGraph;
}

async function waitMs(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function drawWaveformColumn({ colData, outH, amp01 }) {
  // Render a vertical amplitude bar centered in the canvas.
  const mid = (outH - 1) / 2;
  const half = Math.max(0, Math.min(mid, amp01 * mid));

  for (let y = 0; y < outH; y++) {
    const i = y * 4;
    // Background
    let r = 10,
      g = 16,
      b = 28;

    // Waveform bar
    if (Math.abs(y - mid) <= half) {
      // Slight gradient: brighter near center
      const d = 1 - Math.min(1, Math.abs(y - mid) / (half + 1e-6));
      r = Math.round(120 + 100 * d);
      g = Math.round(180 + 60 * d);
      b = Math.round(255 * (0.85 + 0.15 * d));
    }

    colData[i] = r;
    colData[i + 1] = g;
    colData[i + 2] = b;
    colData[i + 3] = 255;
  }
}

async function generateWaveformFromMediaElement({ videoEl, canvas }) {
  await ensureVideoLoadedMetadata(videoEl);
  const duration = videoEl.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video duration unavailable.");

  const { w: outW, h: outH } = setCanvasBackingStoreSize(canvas, 100);
  const cols = Math.max(256, Math.min(1200, outW));

  setStatus("Preparing waveform…");
  const { analyser } = await ensureMediaAudioGraph(videoEl, 2048);
  analyser.smoothingTimeConstant = 0.8;

  const time = new Float32Array(analyser.fftSize);

  const sampleCanvas = makeTempCanvas(cols, outH);
  const ctxSample = sampleCanvas.getContext("2d", { alpha: false });
  ctxSample.imageSmoothingEnabled = false;
  ctxSample.fillStyle = "#0f1620";
  ctxSample.fillRect(0, 0, cols, outH);

  const imgCol = ctxSample.createImageData(1, outH);
  const colData = imgCol.data;

  const ctxOut = canvas.getContext("2d", { alpha: false });
  ctxOut.imageSmoothingEnabled = false;
  ctxOut.fillStyle = "#0f1620";
  ctxOut.fillRect(0, 0, outW, outH);

  const wasPaused = videoEl.paused;
  const priorTime = videoEl.currentTime;
  const priorMuted = videoEl.muted;
  const priorVolume = videoEl.volume;
  const priorPlaybackRate = videoEl.playbackRate;

  try {
    videoEl.muted = false;
    videoEl.volume = 0;
    if (!wasPaused) videoEl.pause();
    await seekVideo(videoEl, 0);

    // Stream through quickly and paint amplitude over time.
    videoEl.playbackRate = 16;
    await videoEl.play();
    await waitForEventOrTimeout(videoEl, "playing", 1000);

    const painted = new Uint8Array(cols);
    let paintedCount = 0;
    const startWall = performance.now();

    while (paintedCount < cols) {
      const t = videoEl.currentTime;
      if (!Number.isFinite(t)) break;
      const x = Math.min(cols - 1, Math.max(0, Math.floor((t / duration) * (cols - 1))));

      analyser.getFloatTimeDomainData(time);
      // RMS amplitude
      let s = 0;
      for (let i = 0; i < time.length; i++) s += time[i] * time[i];
      const rms = Math.sqrt(s / time.length);
      const amp = clamp01(rms * 6); // scale factor tuned for typical media levels

      if (painted[x] === 0) {
        drawWaveformColumn({ colData, outH, amp01: amp });
        ctxSample.putImageData(imgCol, x, 0);
        painted[x] = 1;
        paintedCount++;
      }

      const frac = paintedCount / cols;
      const elapsed = (performance.now() - startWall) / 1000;
      const eta = frac > 0.02 ? Math.round((elapsed * (1 - frac)) / frac) : null;
      setStatus(`Generating waveform… ${paintedCount}/${cols}${eta ? ` (ETA ~${eta}s)` : ""}`);

      if (t >= duration - 0.05) break;
      await waitMs(16);
      if (performance.now() - startWall > 120000) break;
    }

    videoEl.pause();
    ctxOut.clearRect(0, 0, outW, outH);
    ctxOut.drawImage(sampleCanvas, 0, 0, outW, outH);
  } finally {
    setStatus("");
    videoEl.volume = priorVolume;
    videoEl.muted = priorMuted;
    videoEl.playbackRate = priorPlaybackRate;
    await seekVideo(videoEl, priorTime);
    if (!wasPaused) videoEl.play().catch(() => {});
  }
}

async function generateSpectrogramFromMediaElement({ videoEl, canvas }) {
  await ensureVideoLoadedMetadata(videoEl);
  const duration = videoEl.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video duration unavailable.");

  const { w: outW, h: outH } = setCanvasBackingStoreSize(canvas, 100);
  const cols = Math.max(256, Math.min(800, outW));

  setStatus("Preparing audio analyser…");
  const { analyser, freqDb } = await ensureMediaAudioGraph(videoEl, 2048);
  const bins = analyser.frequencyBinCount;

  // Render at sampling resolution then scale to full width.
  const sampleCanvas = makeTempCanvas(cols, outH);
  const ctxSample = sampleCanvas.getContext("2d", { alpha: false });
  ctxSample.imageSmoothingEnabled = false;
  ctxSample.fillStyle = "#0f1620";
  ctxSample.fillRect(0, 0, cols, outH);

  const imgCol = ctxSample.createImageData(1, outH);
  const colData = imgCol.data;

  const ctxOut = canvas.getContext("2d", { alpha: false });
  ctxOut.imageSmoothingEnabled = false;
  ctxOut.fillStyle = "#0f1620";
  ctxOut.fillRect(0, 0, outW, outH);

  const wasPaused = videoEl.paused;
  const priorTime = videoEl.currentTime;
  const priorMuted = videoEl.muted;
  const priorVolume = videoEl.volume;
  const priorPlaybackRate = videoEl.playbackRate;

  try {
    // Avoid audible glitches while seeking/playing tiny snippets.
    // Some browsers effectively treat muted media element audio as silence upstream of the analyser,
    // so prefer volume=0 with muted=false.
    videoEl.muted = false;
    videoEl.volume = 0;
    // Streaming analyser approach:
    // Instead of doing hundreds of seeks (slow + flaky), play through once at high playbackRate,
    // continuously sample analyser bins, and fill columns as time advances.
    if (!wasPaused) videoEl.pause();
    await seekVideo(videoEl, 0);

    const minBin = 1;
    const maxBin = bins - 1;
    const logMin = Math.log(minBin);
    const logMax = Math.log(maxBin);

    // Track which columns have been painted.
    const painted = new Uint8Array(cols);
    let paintedCount = 0;

    // Use the fastest playbackRate the browser will reasonably allow.
    // (Some browsers clamp this; that's fine.)
    const targetRate = 16;
    videoEl.playbackRate = targetRate;

    // Start playback to drive analyser.
    await videoEl.play();
    await waitForEventOrTimeout(videoEl, "playing", 1000);

    const startWall = performance.now();

    while (paintedCount < cols) {
      const t = videoEl.currentTime;
      if (!Number.isFinite(t)) break;
      const x = Math.min(cols - 1, Math.max(0, Math.floor((t / duration) * (cols - 1))));

      analyser.getFloatFrequencyData(freqDb);

      // Detect dead analyser output (all min dB) and just keep going; this often resolves once decoding catches up.
      let hasSignal = false;
      for (let i = 0; i < freqDb.length; i++) {
        const v = freqDb[i];
        if (Number.isFinite(v) && v > analyser.minDecibels + 1) {
          hasSignal = true;
          break;
        }
      }

      if (hasSignal && painted[x] === 0) {
        for (let y = 0; y < outH; y++) {
          const fy = 1 - y / (outH - 1);
          const logBin = logMin + fy * (logMax - logMin);
          const b = Math.min(maxBin, Math.max(minBin, Math.round(Math.exp(logBin))));

          const rawDb = freqDb[b];
          const db = Number.isFinite(rawDb) ? rawDb : analyser.minDecibels;
          const v = clamp01((db + 90) / 80);

          const i = y * 4;
          const r = Math.round(255 * Math.pow(v, 0.85));
          const g = Math.round(220 * Math.pow(v, 1.35));
          const bb = Math.round(255 * (0.15 + 0.85 * Math.pow(v, 0.7)));
          colData[i] = r;
          colData[i + 1] = g;
          colData[i + 2] = bb;
          colData[i + 3] = 255;
        }

        ctxSample.putImageData(imgCol, x, 0);
        painted[x] = 1;
        paintedCount++;
      }

      // Progress
      const frac = paintedCount / cols;
      const elapsed = (performance.now() - startWall) / 1000;
      const eta = frac > 0.02 ? Math.round((elapsed * (1 - frac)) / frac) : null;
      setStatus(`Generating spectrogram… ${paintedCount}/${cols}${eta ? ` (ETA ~${eta}s)` : ""}`);

      // Stop when we reach the end.
      if (t >= duration - 0.05) break;

      // Yield to UI; analyser updates are ~60Hz-ish.
      await waitMs(16);

      // Safety: if something goes wrong (e.g. time doesn't advance), avoid an infinite loop.
      if (performance.now() - startWall > 120000) break; // 2 minutes max
    }

    videoEl.pause();

    // Scale to full canvas width.
    ctxOut.clearRect(0, 0, outW, outH);
    ctxOut.drawImage(sampleCanvas, 0, 0, outW, outH);
  } finally {
    setStatus("");
    videoEl.volume = priorVolume;
    videoEl.muted = priorMuted;
    videoEl.playbackRate = priorPlaybackRate;
    await seekVideo(videoEl, priorTime);
    if (!wasPaused) videoEl.play().catch(() => {});
  }
}

async function generateSpectrogram({ file, canvas }) {
  // decodeAudioData has a hard 2GB limit for the input ArrayBuffer.
  // For very large video files, fall back to sampling via a MediaElementAudioSource + AnalyserNode.
  const twoGb = 2 * 1024 * 1024 * 1024;
  const safeDecodeLimit = Math.floor(twoGb * 0.85);

  if (file.size > safeDecodeLimit) {
    throw new Error(
      "File is too large to decode audio in-browser for a spectrogram (>~2GB). Use an audio proxy (e.g. a small WAV) for spectrogram generation."
    );
  }

  try {
    setStatus("Decoding audio…");
    const audioBuffer = await decodeAudioFromFile(file);
    setStatus("Downsampling audio…");
    const { samples: mono, sampleRate } = await downsampleAudioToMono(audioBuffer, settings.audioSampleRate);

    // For a 100px-tall display, we can use a smaller FFT and fewer frames.
    const fftSize = settings.fftSize;
    const hopSize = Math.max(64, fftSize >> 2);

    // Only compute the number of time-columns we will render (then scale to full width if needed).
    const { w: outW } = setCanvasBackingStoreSize(canvas, 100);
    const cols = Math.max(256, Math.min(900, outW));

    setStatus(`Computing spectrogram… 0/${cols}`);
    const stft = stftMagnitudeSampled({
      samples: mono,
      sampleRate,
      fftSize,
      hopSize,
      sampleColumns: cols,
    });

    setStatus("Rendering spectrogram…");
    renderSpectrogramToCanvas({ canvas, stft, widthPx: cols });
    setStatus("");

    const { t0, t1 } = getEffectiveWindow();
    state.spectrogram = {
      cols,
      bins: stft.bins,
      sampleRate,
      fftSize,
      hopSize,
      t0,
      t1,
      mag: stft.mag,
    };
  } catch (e) {
    // Only intercept the specific >2GB decode limit case.
    const msg = String(e?.message || e);
    if (msg.includes("larger than 2 GB") || msg.includes("larger than 2GB") || msg.includes("2 GB")) {
      throw new Error(
        "Audio decode failed due to the browser's ~2GB decodeAudioData limit. For a spectrogram on large files, use an audio proxy (small WAV/MP3)."
      );
    }
    throw e;
  }
}

async function regenerateAll() {
  if (!currentFile) return;

  els.downloadVideogramBtn.disabled = true;
  els.downloadSpectrogramBtn.disabled = true;
  els.downloadVideogramCsvBtn.disabled = true;
  els.downloadSpectrogramCsvBtn.disabled = true;
  els.regenBtn.disabled = true;

  try {
    await ensureVideoLoadedMetadata(els.video);

    // Ensure canvases match current layout width before rendering.
    setCanvasBackingStoreSize(els.videogram, 100);
    setCanvasBackingStoreSize(els.spectrogram, 100);

    // Generate videogram first (needs video element to be seekable).
    await generateVideogram({
      videoEl: els.video,
      canvas: els.videogram,
      columns: els.videogram.width,
    });

    // Spectrogram from file audio.
    await generateSpectrogram({ file: currentFile, canvas: els.spectrogram });

    els.downloadVideogramBtn.disabled = false;
    els.downloadSpectrogramBtn.disabled = false;
    els.downloadVideogramCsvBtn.disabled = !state.videogram;
    els.downloadSpectrogramCsvBtn.disabled = !state.spectrogram;
  } catch (e) {
    console.error(e);
    setStatus(`Error: ${e?.message || String(e)}`);
  } finally {
    els.regenBtn.disabled = false;
    updatePlayheads();
  }
}

function setVideoFromFile(file) {
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(file);
  currentFile = file;

  els.video.src = currentObjectUrl;
  els.video.load();

  drawPlaceholder(els.videogram, "Videogram will appear here");
  drawPlaceholder(els.spectrogram, "Spectrogram will appear here");
  setStatus("Loading video metadata…");

  els.downloadVideogramBtn.disabled = true;
  els.downloadSpectrogramBtn.disabled = true;
  els.regenBtn.disabled = true;

  ensureVideoLoadedMetadata(els.video)
    .then(() => {
      setStatus("");
      els.regenBtn.disabled = false;
      regenerateAll();
    })
    .catch((e) => {
      console.error(e);
      setStatus("Could not load video metadata.");
      els.regenBtn.disabled = false;
    });
}

function onResize() {
  // Keep playheads visually correct; user can regenerate for a crisp re-render.
  updatePlayheads();
}

// Wiring
hookCanvasSeekingAndSelection(els.videogram, els.selectionVideo);
hookCanvasSeekingAndSelection(els.spectrogram, els.selectionAudio);

els.fileInput.addEventListener("change", () => {
  const f = els.fileInput.files?.[0];
  if (!f) return;
  setVideoFromFile(f);
  // Prime the audio context during a user gesture to reduce autoplay / resume issues later.
  ensureMediaAudioGraph(els.video).catch(() => {});
});

els.regenBtn.addEventListener("click", () => {
  readSettingsFromUi();
  regenerateAll();
});

els.downloadVideogramBtn.addEventListener("click", () => {
  downloadCanvasPng(els.videogram, "videogram.png");
});

els.downloadSpectrogramBtn.addEventListener("click", () => {
  downloadCanvasPng(els.spectrogram, "spectrogram.png");
});

els.downloadVideogramCsvBtn.addEventListener("click", () => {
  const vg = state.videogram;
  if (!vg) return;
  // Rows = y index, Cols = time sample index
  const lines = [];
  lines.push(`# videogram rows=${vg.rows} cols=${vg.cols} t0=${vg.t0} t1=${vg.t1}`);
  const header = ["y"].concat(
    Array.from({ length: vg.cols }, (_, i) => {
      const t = vg.t0 + (i / Math.max(1, vg.cols - 1)) * (vg.t1 - vg.t0);
      return t.toFixed(6);
    })
  );
  lines.push(header.join(","));
  for (let y = 0; y < vg.rows; y++) {
    const row = [String(y)];
    for (let x = 0; x < vg.cols; x++) row.push(vg.data[x * vg.rows + y].toFixed(3));
    lines.push(row.join(","));
  }
  downloadTextFile(lines.join("\n"), "videogram.csv", "text/csv");
});

els.downloadSpectrogramCsvBtn.addEventListener("click", () => {
  const sp = state.spectrogram;
  if (!sp) return;
  const lines = [];
  lines.push(
    `# spectrogram cols=${sp.cols} bins=${sp.bins} sampleRate=${sp.sampleRate} fftSize=${sp.fftSize} hopSize=${sp.hopSize} t0=${sp.t0} t1=${sp.t1}`
  );
  lines.push(["col", "time_s", "bin", "freq_hz", "mag"].join(","));
  const bins = sp.bins;
  for (let x = 0; x < sp.cols; x++) {
    const t = sp.t0 + (x / Math.max(1, sp.cols - 1)) * (sp.t1 - sp.t0);
    const base = x * bins;
    for (let b = 0; b < bins; b++) {
      const freq = (b * sp.sampleRate) / sp.fftSize;
      lines.push([x, t.toFixed(6), b, freq.toFixed(3), sp.mag[base + b].toExponential(6)].join(","));
    }
  }
  downloadTextFile(lines.join("\n"), "spectrogram.csv", "text/csv");
});

els.settingsBtn.addEventListener("click", () => {
  const isHidden = els.settingsPanel.hasAttribute("hidden");
  if (isHidden) els.settingsPanel.removeAttribute("hidden");
  else els.settingsPanel.setAttribute("hidden", "");
});

els.resetZoomBtn.addEventListener("click", () => {
  state.viewWindow = null;
  state.selection = null;
  updateSelectionOverlay();
  updatePlayheads();
  regenerateAll();
});

for (const el of [
  els.audioSampleRate,
  els.fftSize,
  els.colorMapSpec,
  els.colorMapVideo,
  els.videoDecodeW,
  els.videoSamplesPerSec,
]) {
  el.addEventListener("change", () => {
    readSettingsFromUi();
  });
}

els.video.addEventListener("timeupdate", updatePlayheads);
els.video.addEventListener("seeked", updatePlayheads);
els.video.addEventListener("loadedmetadata", updatePlayheads);

window.addEventListener("resize", onResize);

drawPlaceholder(els.videogram, "Videogram will appear here");
drawPlaceholder(els.spectrogram, "Spectrogram will appear here");
setStatus("Choose a video file to begin.");

loadSettings();
applySettingsToUi();


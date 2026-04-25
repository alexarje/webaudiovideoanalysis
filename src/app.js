const els = {
  fileInput: document.getElementById("fileInput"),
  regenBtn: document.getElementById("regenBtn"),
  video: document.getElementById("video"),
  status: document.getElementById("status"),
  videogram: document.getElementById("videogram"),
  spectrogram: document.getElementById("spectrogram"),
  downloadVideogramBtn: document.getElementById("downloadVideogramBtn"),
  downloadSpectrogramBtn: document.getElementById("downloadSpectrogramBtn"),
  playheadVideo: document.getElementById("playheadVideo"),
  playheadAudio: document.getElementById("playheadAudio"),
};

/** @type {string | null} */
let currentObjectUrl = null;
/** @type {File | null} */
let currentFile = null;

function setStatus(msg) {
  els.status.textContent = msg || "";
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
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
  const frac = clamp01(v.currentTime / duration);
  const set = (playhead, canvas) => {
    const wrap = canvas.parentElement;
    if (wrap) wrap.classList.add("hasMedia");
    playhead.style.left = `${frac * 100}%`;
  };
  set(els.playheadVideo, els.videogram);
  set(els.playheadAudio, els.spectrogram);
}

function hookCanvasSeeking(canvas) {
  canvas.addEventListener("pointerdown", (e) => {
    const v = els.video;
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const r = canvas.getBoundingClientRect();
    const frac = clamp01((e.clientX - r.left) / r.width);
    v.currentTime = frac * duration;
  });
}

function downloadCanvasPng(canvas, filename) {
  const a = document.createElement("a");
  a.download = filename;
  a.href = canvas.toDataURL("image/png");
  document.body.appendChild(a);
  a.click();
  a.remove();
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
  const maxSamples = 900;
  const minSamples = 256;
  const samplesPerSecond = 6; // lower = faster; visuals still readable at 100px tall
  const targetSamplesByDuration = Math.round(duration * samplesPerSecond);
  const desired = Math.max(minSamples, Math.min(maxSamples, targetSamplesByDuration));
  const colsToRender = Math.max(8, Math.min(columns ?? outW, outW, desired));

  // Draw each sampled time as a 1px (or scaled) column in output.
  // We only need row averages, so decode width can be quite small.
  const decodeW = 128;
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

    for (let outX = 0; outX < colsToRender; outX++) {
      const t = (outX / Math.max(1, colsToRender - 1)) * duration;
      setStatus(`Generating videogram… ${outX + 1}/${colsToRender}`);
      await seekVideo(videoEl, t);

      ctxTmp.drawImage(videoEl, 0, 0, decodeW, decodeH);
      const frame = ctxTmp.getImageData(0, 0, decodeW, decodeH);
      const bins = rowAveragesToBins(frame, decodeW, decodeH, outH);

      // Map luminance to false-color (blue->cyan->yellow->white)
      for (let y = 0; y < outH; y++) {
        const v = clamp01(bins[y] / 255);
        const i = y * 4;
        const r = Math.round(255 * Math.pow(v, 0.85));
        const g = Math.round(255 * Math.pow(v, 0.65));
        const b = Math.round(255 * (0.25 + 0.75 * Math.pow(v, 0.9)));
        colData[i] = r;
        colData[i + 1] = g;
        colData[i + 2] = b;
        colData[i + 3] = 255;
      }

      ctxSample.putImageData(imgCol, outX, 0);
    }

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

      // False color: dark -> purple -> orange -> white
      const r = Math.round(255 * Math.pow(v, 0.85));
      const g = Math.round(220 * Math.pow(v, 1.35));
      const bb = Math.round(255 * (0.15 + 0.85 * Math.pow(v, 0.7)));

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
    // For very large files, waveform is more stable than trying to compute a spectrogram from the media element.
    await generateWaveformFromMediaElement({ videoEl: els.video, canvas });
    return;
  }

  try {
    setStatus("Decoding audio…");
    const audioBuffer = await decodeAudioFromFile(file);
    setStatus("Downsampling audio…");
    const { samples: mono, sampleRate } = await downsampleAudioToMono(audioBuffer, 11025);

    // For a 100px-tall display, we can use a smaller FFT and fewer frames.
    const fftSize = 1024;
    const hopSize = 256;

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
  } catch (e) {
    // If decode fails (including >2GB errors), fall back to analyser sampling.
    const msg = String(e?.message || e);
    if (msg.includes("decodeAudioData") || msg.includes("2 GB") || msg.includes("2GB")) {
      console.warn("decodeAudioData failed; falling back to waveform.", e);
      await generateWaveformFromMediaElement({ videoEl: els.video, canvas });
      return;
    }
    throw e;
  }
}

async function regenerateAll() {
  if (!currentFile) return;

  els.downloadVideogramBtn.disabled = true;
  els.downloadSpectrogramBtn.disabled = true;
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
hookCanvasSeeking(els.videogram);
hookCanvasSeeking(els.spectrogram);

els.fileInput.addEventListener("change", () => {
  const f = els.fileInput.files?.[0];
  if (!f) return;
  setVideoFromFile(f);
  // Prime the audio context during a user gesture to reduce autoplay / resume issues later.
  ensureMediaAudioGraph(els.video).catch(() => {});
});

els.regenBtn.addEventListener("click", () => {
  regenerateAll();
});

els.downloadVideogramBtn.addEventListener("click", () => {
  downloadCanvasPng(els.videogram, "videogram.png");
});

els.downloadSpectrogramBtn.addEventListener("click", () => {
  downloadCanvasPng(els.spectrogram, "spectrogram.png");
});

els.video.addEventListener("timeupdate", updatePlayheads);
els.video.addEventListener("seeked", updatePlayheads);
els.video.addEventListener("loadedmetadata", updatePlayheads);

window.addEventListener("resize", onResize);

drawPlaceholder(els.videogram, "Videogram will appear here");
drawPlaceholder(els.spectrogram, "Spectrogram will appear here");
setStatus("Choose a video file to begin.");


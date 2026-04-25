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

async function ensureVideoLoadedMetadata(videoEl) {
  if (Number.isFinite(videoEl.duration) && videoEl.duration > 0 && videoEl.videoWidth > 0) return;
  if (videoEl.readyState >= 1) return;
  await waitForEvent(videoEl, "loadedmetadata");
}

async function seekVideo(videoEl, t) {
  const target = Math.max(0, Math.min(t, (videoEl.duration || 0) - 1e-3));
  if (!Number.isFinite(target)) return;
  if (Math.abs(videoEl.currentTime - target) < 1e-4) return;
  videoEl.currentTime = target;
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
  // Render one output column per output pixel to avoid duplicated/skipped columns.
  // (Using Math.round mapping caused multiple samples to land on the same pixel for many widths.)
  const cols = Math.max(8, Math.min(columns ?? outW, outW));
  const colsToRender = outW;
  const ctxOut = canvas.getContext("2d", { alpha: false });
  ctxOut.imageSmoothingEnabled = false;
  ctxOut.fillStyle = "#0f1620";
  ctxOut.fillRect(0, 0, outW, outH);

  // Draw each sampled time as a 1px (or scaled) column in output.
  // We use a modest decode size to keep this fast.
  const decodeW = Math.min(320, Math.max(96, videoEl.videoWidth || 320));
  const decodeH = Math.round((decodeW * (videoEl.videoHeight || 180)) / (videoEl.videoWidth || 320));
  const temp = makeTempCanvas(decodeW, decodeH);
  const ctxTmp = temp.getContext("2d", { willReadFrequently: true });

  const imgCol = ctxOut.createImageData(1, outH);
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

      ctxOut.putImageData(imgCol, outX, 0);
    }
  } finally {
    setStatus("");
    await seekVideo(videoEl, priorTime);
    if (!wasPaused) videoEl.play().catch(() => {});
  }
}

function hann(n, N) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
}

function stftMagnitude({ samples, sampleRate, fftSize, hopSize }) {
  // Real-valued radix-2 FFT via naive DFT is too slow; implement a simple Cooley–Tukey iterative FFT.
  const N = fftSize;
  const H = hopSize;
  const frames = Math.max(1, Math.floor((samples.length - N) / H) + 1);
  const bins = N / 2 + 1;

  const window = new Float32Array(N);
  for (let i = 0; i < N; i++) window[i] = hann(i, N);

  const mag = new Float32Array(frames * bins);
  const re = new Float32Array(N);
  const im = new Float32Array(N);

  // Precompute bit-reversal indices.
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

  // Precompute twiddles per stage.
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

  for (let f = 0; f < frames; f++) {
    const off = f * H;
    // Load + window into bit-reversed order.
    for (let i = 0; i < N; i++) {
      const s = samples[off + i] ?? 0;
      const v = s * window[i];
      const j = rev[i];
      re[j] = v;
      im[j] = 0;
    }

    // Iterative FFT.
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

    // Magnitudes (one-sided)
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const r = re[b];
      const ii = im[b];
      mag[base + b] = Math.sqrt(r * r + ii * ii);
    }
  }

  return { mag, frames, bins, sampleRate, fftSize, hopSize };
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

async function generateSpectrogram({ file, canvas }) {
  setStatus("Decoding audio…");
  const audioBuffer = await decodeAudioFromFile(file);
  const mono = mixToMono(audioBuffer);

  // Choose a moderate FFT size for speed; still decent resolution for a 100px display.
  const fftSize = 2048;
  const hopSize = 512;

  setStatus("Computing spectrogram…");
  const stft = stftMagnitude({
    samples: mono,
    sampleRate: audioBuffer.sampleRate,
    fftSize,
    hopSize,
  });

  setStatus("Rendering spectrogram…");
  renderSpectrogramToCanvas({ canvas, stft });
  setStatus("");
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


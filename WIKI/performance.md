# Performance notes

## Where the time goes

### Videogram

The slow parts are:

- **Seeking** the `<video>` element repeatedly
- **Decoding** the needed frames
- **Reading pixels** via `getImageData` and doing per-row aggregation

The implementation keeps this manageable by:

- downsampling frames to a small working width (`decodeW = 128`)
- limiting the number of sampled columns (duration-based target with caps)
- using `fastSeek()` when available

### Spectrogram

For typical file sizes, the cost is dominated by:

- audio decode
- resampling (OfflineAudioContext)
- FFT work

The app speeds this up by:

- resampling to a lower rate (11,025 Hz)
- computing FFTs only for the time-columns that will be drawn

For very large files, the analyser fallback avoids decoding the full file but may still be limited by:

- seek performance
- media pipeline update time after each seek

## Practical tuning knobs (current code)

In `src/app.js`:

- **Videogram**
  - `decodeW` (smaller = faster; too small = less detail)
  - `samplesPerSecond`, `minSamples`, `maxSamples` (lower = faster)
- **Spectrogram (decoded STFT)**
  - target resample rate (lower = faster, less HF detail)
  - `fftSize` / `hopSize` (smaller = faster, blurrier)
  - `cols` cap (lower = faster)
- **Spectrogram (analyser fallback)**
  - `cols` cap (lower = faster)
  - `settleMs` after each seek (lower = faster; too low = stale analyser data)

## Further optimizations (ideas)

- **Use `requestVideoFrameCallback`** for videogram sampling on browsers that support it.
- **Web Workers** for CPU-heavy loops (row-averaging, FFT) to keep the UI responsive.
- **Progressive refinement**: render a quick low-sample preview first, then refine in the background.
- **Cache columns**: if the user regenerates with the same file/dimensions, reuse prior samples.


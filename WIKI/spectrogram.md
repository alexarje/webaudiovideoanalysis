# Spectrogram

The app supports two spectrogram pipelines:

1. **Decoded-audio STFT** (fast + consistent for typical file sizes)
2. **Media-element analyser fallback** (works for multi‑GB files where decode is impossible)

Both render to a 100px-tall canvas and fill the full width.

## 1) Decoded-audio STFT pipeline

### Steps

1. Read the selected file into memory (as an `ArrayBuffer`).
2. Decode audio with `AudioContext.decodeAudioData`.
3. Downsample + mixdown to mono using `OfflineAudioContext` (target ~11,025 Hz).
4. Compute magnitudes using a Hann-windowed FFT.
5. Render only the number of time-columns needed for the display.

### “Compute only what you draw”

Instead of computing an STFT for every hop across the full audio, the app selects a number of output columns \(N\) (capped) and computes an FFT only for those \(N\) positions. This reduces work dramatically for long recordings.

### Parameters (current defaults)

- **Sample rate**: 11,025 Hz (after resampling)
- **FFT size**: 1024
- **Hop size**: 256 (conceptually; used to map from time-column to sample offset)
- **Columns**: clamped by canvas width and caps

These values are chosen for speed and a reasonable look at 100px tall, not for lab-grade spectral measurement.

## 2) Media-element analyser fallback (large files)

### Why it exists

Browsers typically enforce a hard limit: `decodeAudioData` cannot accept an input buffer larger than ~2GB. For large videos, reading the entire file into an `ArrayBuffer` also becomes memory-heavy.

### Steps

1. Build an audio graph:
   - `<video>` → `MediaElementAudioSourceNode` → `AnalyserNode` → destination
2. Seek across time to build \(N\) columns.
3. At each time sample:
   - briefly play (muted) to ensure analyser data updates
   - call `analyser.getFloatFrequencyData()` to get dB values for frequency bins
   - map bins to rows (log-ish mapping) and color-map into the output column
4. Scale the sampled image to fill the full canvas width.

### Trade-offs

- **Not a true STFT**: the analyser windowing and timing is managed internally by the browser.
- **Seek-dependent**: accuracy depends on how the browser seeks/decodes at each time sample.
- **May be slower** than decoded STFT for small files, but it avoids the 2GB decode limitation.

## Frequency-axis mapping

The canvas is only 100px tall, so the y-axis uses a **log-ish mapping** from rows to frequency bins:

- top rows represent higher bins (higher frequencies)
- bottom rows represent lower bins

This makes it easier to see both low and high frequency content in a small height.


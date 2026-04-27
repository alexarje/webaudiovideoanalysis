# VideoScrub

VideoScrub is a static web app to load a local video file, play it back, and generate:

- **Videogram**: per-frame row-average stacked over time (100px tall, full width)
- **Spectrogram**: time–frequency visualization (100px tall, full width)
- **Interaction**: click either image to seek the video
- **Export**: download each visualization as a PNG

## How it works

- **Videogram**: samples the video at many time points; for each sampled frame it downsamples the frame, computes the average luminance per row, and stacks those row-averages across time.
- **Spectrogram**:
  - For typical file sizes, it decodes audio in the browser, downsamples to mono, then computes a sampled STFT (only the time-columns that will be drawn).
  - For very large files (or if decode fails), it falls back to sampling audio frequency data from the `<video>` element via `AudioContext + AnalyserNode` while seeking (it uses `volume=0` rather than `muted` during sampling for better cross-browser reliability).

## Usage

- **Load**: click “Choose video…” and pick a local file.
- **Seek**: click anywhere on the videogram or spectrogram to jump to that time in the video.
- **Export**: use “Download PNG” to save either visualization.
- **Regenerate**: recomputes both images (useful after resizing your browser window).

## Notes / limitations

- **Performance**: videogram and spectrogram generation seek/sample through the media; very long videos can take longer (but the app skips work by downsampling and capping sample counts).
- **Codec support**: depends on your browser’s supported formats (e.g. MP4/H.264 is commonly supported).
- **Audio decode limit**: many browsers have a hard ~2GB limit for `decodeAudioData` inputs; the app uses an analyser-based fallback for large files.
- **No audio track**: if a file has no audio (or the browser can’t decode it), spectrogram generation may fail or be blank.

## Run locally

Any static server works. For example:

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173` and choose a video file.

## Technical docs

See the project wiki for deeper technical notes (algorithms, parameters, performance constraints, and extension ideas).

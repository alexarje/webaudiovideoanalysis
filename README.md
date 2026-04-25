# Web Audio Video Analysis

Static web app to load a local video file, play it back, and generate:

- **Videogram**: per-frame row-average stacked over time (100px tall, full width)
- **Spectrogram**: STFT spectrogram of decoded audio (100px tall, full width)
- **Interaction**: click either image to seek the video
- **Export**: download each visualization as a PNG

## How it works

- **Videogram**: samples the video at many time points; for each sampled frame it computes the average luminance per row, then stacks those row-averages across time.
- **Spectrogram**: decodes the audio track in the browser and computes an STFT magnitude spectrogram.

## Usage

- **Load**: click “Choose video…” and pick a local file.
- **Seek**: click anywhere on the videogram or spectrogram to jump to that time in the video.
- **Export**: use “Download PNG” to save either visualization.
- **Regenerate**: recomputes both images (useful after resizing your browser window).

## Notes / limitations

- **Performance**: videogram generation seeks through the video many times; very long or high-resolution videos can take longer.
- **Codec support**: depends on your browser’s supported formats (e.g. MP4/H.264 is commonly supported).
- **Audio decode**: if a file has no audio track (or audio can’t be decoded), spectrogram generation may fail.

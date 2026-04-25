# Videogram (row-average over time)

## Definition

The videogram rendered by this app is a compact spatiotemporal visualization where:

- The **x-axis** is time across the full video duration.
- The **y-axis** is vertical position in the frame (top → bottom).
- Each column is derived from a video frame sampled at some timestamp \(t\).

For each sampled frame, we compute a **row-wise average luminance**:

\[
V_t(y) = \frac{1}{W}\sum_{x=0}^{W-1} \text{luma}(x,y)
\]

where \(W\) is the frame width (after downsampling).

The result is a 1D vector \(V_t\) of length equal to the output canvas height (100px, scaled to device pixel ratio).

## Implementation sketch

At a high level (`src/app.js`):

1. Pick a number of time samples \(N\) (`colsToRender`).
2. For each column \(i \in [0, N-1]\), compute \(t_i = i/(N-1)\cdot \text{duration}\).
3. Seek the `<video>` element to \(t_i\) (using `fastSeek()` when available).
4. Draw the current frame into a small offscreen canvas (`decodeW = 128`).
5. Compute per-row luma averages and downsample to the output height.
6. Color-map that 1D vector into an RGB column and write it into the videogram image.
7. Scale the sampled image to fill the full output width.

## Why downsampling is OK here

Because the final visualization only uses **row-averaged luminance**, high horizontal resolution is not needed. Downsampling to a small width:

- reduces the cost of `getImageData`
- reduces the number of pixels iterated per frame
- produces a similar row-average signal (minor differences due to resampling)

## Sampling strategy and “frame count”

Generating a videogram requires seeking and sampling frames. The app chooses \(N\) adaptively to limit work on long videos:

- A duration-based target (samples per second)
- A minimum sample count (so short clips still look smooth)
- A maximum cap (to avoid thousands of seeks)

The UI progress text **`i/N`** is the number of sampled frames actually processed (not the full video’s native frame count).

## Trade-offs / possible improvements

- **More accurate sampling**: using `requestVideoFrameCallback` (where supported) can help ensure the sampled frame is the one corresponding to the requested time.
- **Better temporal sampling**: sample based on keyframes or use an adaptive strategy (more samples in high-change regions).
- **Different videograms**: use column-average instead of row-average, or compute per-row color averages (RGB) instead of luma only.


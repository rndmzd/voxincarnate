# Vendored HeadAudio inference assets

Upstream: https://github.com/met4citizen/HeadAudio

Pinned revision: `d3af5f9ff86ab6b2b1913d411a4e1922ec101953` (2025-12-10).
Retrieved 2026-10-16. Files below are unmodified upstream bytes, licensed under the
included MIT LICENSE (Copyright 2025 Mika Suominen).

| Local file | Upstream path | SHA-256 |
| --- | --- | --- |
| headworklet.min.mjs | dist/headworklet.min.mjs | 37ebeb1d4d7e41fca7d12bb8fb411f7ce6bb21a2589602dec18e0a48b343be55 |
| model-en-mixed.bin | dist/model-en-mixed.bin | 0358f68989b5861f9b7d18871b010fa6cbf88a53bda4954a954d8c548bbcf251 |
| LICENSE | LICENSE | d45d4192f4e7502846c6b01d743eddbff20b3752e4c350a88418f59e4587a60f |

The mixed English model was trained upstream on four HeadTTS voices. It is an
MFCC/Gaussian-prototype classifier, not a transcript or phoneme-timestamp service.
Detection is approximate and has not been calibrated specifically for Sesame.
The upstream author reports roughly 50–100 ms processing latency.

Voxincarnate uses its own typed node/controller and A–H/X transition mapping in
`desktop/audio`, with the upstream worklet and pretrained model. This avoids the
upstream `HeadAudio._onmessage` truthiness check that discards valid viseme ID 0
(AA). It also handles 'ended' events, cancellation, malformed model data and
stale articulation explicitly. The vendor files themselves have no patches.
Articulation timestamps retain the worklet's source-audio acquisition time;
repeated interpolation updates do not relabel that prediction with wall time.

The worklet has no outputs and runs alongside the existing silent RMS analysis
branch. The model and worklet are bundled local Vite assets; runtime inference
does not require a CDN, account, cloud service, network request to a remote host,
audio recording, or duplicate audible playback. No audio delay is added.

The app applies its bounded input gain to an analysis-only GainNode before the
classifier. HeadAudio's separate FFT-energy VAD is disabled because its energy
units differ from the app's RMS dB thresholds. The existing RMS detector remains
the sole activity gate, including live gain/threshold/hold edits. When that gate
is closed, articulation immediately returns to rest; while it is open, the model
can still produce closed speech poses such as P/B/M independently of volume.

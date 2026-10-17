# Windows desktop validation

## October 17 optional animation sound effects

The character builder now stores one optional WAV for each animation type:
Walking, Smoke, and Fall / Jump. Entrance and exit share the selection for their
type. Existing characters remain silent until a sound is selected and saved.
The supplied `sounds/puff_of_smoke.wav` and `sounds/footsteps.wav` are available
as presets; custom WAVs are copied into managed character storage.

- `npm run check` passed strict TypeScript, **152 tests**, and the production build.
  Sound regressions cover all three effects in both directions, stale commands,
  reconnect baselines, interrupted playback, optional silence, playback errors,
  WAV validation, persistence, character asset isolation, deletion/draft cleanup,
  authenticated media serving and byte ranges.
- `npm run pack` built the Windows directory package. Both packaged WAVs matched
  their original source files by SHA-256.
- The packaged executable passed `--smoke-test --motion-sound-check`. This uses
  an isolated `.qa/motion-sound-profile` and a free loopback port, preserving the
  normal app/profile and an already-running overlay. The test imported both
  presets, imported a custom WAV, cancelled a subsequent picker without losing
  that selection, saved/reloaded, and removed only the custom source fixture to
  verify the managed copy still works.
- Real HTMLAudioElement decoding and Web Audio probes observed nonzero samples
  from both supplied sounds and the custom WAV. Smoke entrance and exit used
  the same file in the studio and isolated overlay. Interruptions stopped the
  preceding sound. On-air commands produced no duplicate studio playback;
  No sound and loaded/refreshed overlay snapshots produced no sound replay.
  The smoke windows were muted; this validates decoded signals, not physical
  speaker output or an OBS recording.
- Production editor captures at the supported 1440 and 1120 window widths showed
  all three shared sound rows without clipping or horizontal overflow. Listen
  changes to Stop while auditioning, and its accessible name includes its visible
  label. Save remains in the sticky top bar.

Run `npm run smoke:sounds` to reproduce the focused Electron checks. The private
reports and screenshots are under `.qa/`. Enable **Control audio via OBS** in the
Browser Source properties to route on-air effects through its mixer channel.
Physical OBS recording/monitoring and clean-machine installation remain
**NOT RUN** for this change. No release was published.

## October 16 face detection and natural speech blending

Imported-image creation now detects a face with two associated eyes and a nested
mouth, rejecting uncertain or inconsistent landmarks. Both regions are displayed
for review before generating artwork, and can be edited manually. Mouth mode is
the default; optional face mode permits subtle cheek and brow expressions within
the selected face.

Speech uploads a square context repeated in a fixed nine-cell template plus a
matching PNG mask. This preserves the input framing instead of stretching a tight
mouth crop. Local composition uses a broad elliptical feather and robust, bounded
perimeter color matching. Every byte outside the selected region and the original
alpha remain unchanged; X/rest is restored from the exact original. Face selections
may cover up to 65% for portraits; mouth selections remain limited to 25%.

- `npm run check` passes strict TypeScript, **123 tests**, and the production build.
  Regressions cover guitar-height/out-of-face mouths, missing/inverted eyes,
  uncertain detection, mask geometry, portrait bounds including outward pixel
  rounding, lighting seams on textured skin, alpha and immutable body pixels.
- The full native Electron smoke run passed overall, including the legacy viseme
  flow and character creation. It exercised explicit face detection review,
  manual mouth selection, optional face expressions, all nine decoded speech
  poses, save/reload, and the existing motion controls. All API calls used local
  fixtures; **zero paid API requests** were made.
- Native pixel comparisons verified all nine mouth-mode images outside the mouth
  and face-mode images outside the face against their original source. Rest was
  exact in both modes. The face/mouth review and four manual fields were visually
  inspected at desktop and minimum window sizes without clipping or overflow.
- Independent source review found and fixed portrait rounding and floating-point
  containment edge cases; independent screenshot review approved the new controls.

Real detection on the user's guitar character, live generated facial quality,
and a new physical OBS recording remain **NOT RUN**. Existing characters need
regeneration from their original reference to receive these speech improvements.
The normal profile and its existing artwork were preserved.

## October 16 direction, entrance effects, and protected mouth edits

The source now defaults new walking kits to right-edge entry (moving left) and
right-edge exit (moving right). Creation exposes independent effects and edges
before any generation. Playback uses decoded alpha bounds, sprite transforms,
and the actual viewport; the studio no longer clips travel to an inset character
canvas. Existing explicit clip settings are retained.

Smoke appearance/disappearance and falling/bouncing in followed by jumping out
use the resting artwork. Saved gait frames remain available when switching back
to walking, but local effects never cycle them. Only walking effects request
generated walking artwork.

Speech now sends a selected mouth crop to the image model and composites patches
locally. Vision can find the region, or the user can draw/edit it. The source
canvas, alpha, and pixels outside the region are preserved, including textured
body pixels; X/rest is the original. Older generated sets are retained and need
regeneration from the original reference to receive this behavior.

- `npm run check` passed TypeScript, **113 tests**, and the production build.
  Coverage includes bounds/edge contact on wide and portrait viewports, direction
  mirroring, all effect timelines and serialized OBS factories, strict storage,
  cropped API uploads, and exact outside-region pixel preservation. Premultiplied
  translucent pixel blending has separate coverage.
  Entry specifically uses the first gait frame's visible bounds; exit uses that
  walking clip's union. Wider original/mouth artwork cannot create a travel gap.
- The native character-creation fixture passed direction/default controls,
  automatic and manual mouth selection, all nine decoded speech frames, exact
  source pixel comparisons outside the region, unchanged X/rest, saved reload,
  local smoke and fall/jump entrance/exit completion, and ordered OBS presence IPC.
  These are synthetic fixture checks, with zero paid API requests.
- A kit created with smoke entrance and fall/jump exit retained all eleven speech
  mappings, zero motion frames, selected effects and durations through reload,
  with **zero walking API requests**. Manual mouth selection was inspected at
  desktop and minimum window sizes; all four numeric fields remained visible,
  with no horizontal overflow. The final full native rerun passed its overall,
  legacy viseme, character-creation, and local-effect subchecks.
- Pixel measurement in Electron uses narrowly scoped CORS for authenticated managed
  image GET/HEAD requests from the local studio's `file://`/opaque origins. Overlay
  pages and WebSockets retain their origin restrictions; foreign origins and wrong
  tokens are tested as denied.
- The earlier legacy viseme screenshot subcheck intermittently returned
  `UnknownVizError`. Screenshot retries are bounded, and the smoke aggregator now
  marks a returned failed subcheck as a failed overall run instead of reporting a
  false pass. Individual subcheck results remain the evidence for each run.

The test profile is still `.qa/profile`. The normal user profile, live website
session, and existing saved artwork were not used for these checks. Real generated
mouth-patch quality and a new physical OBS recording remain **NOT RUN**. The
character-creation smoke command below also exercises the new paths.

## October 16 character creation suite checkpoint

The source now includes a single-image creation suite, optional OpenAI concept
and source-image generation, nine speech mouth shapes with binary fallbacks, and
separate walk-in/walk-out sprite clips. Generated output opens as an unsaved draft
for review. This checkpoint does not update the previously packaged release.

- `npm run check` passed strict TypeScript, 90 automated tests, and the production
  renderer/main/preload build. Coverage includes mocked OpenAI request formats,
  cancellation, timeouts, billing-safe no-retry behavior, sanitized errors, invalid
  output, managed motion assets, and shared studio/OBS motion timelines.
- Electron smoke with the existing prerecorded synthetic speech fixture and
  `--character-suite-check` passed. Its deterministic API substitute made **zero
  paid requests** and exercised the real UI, preload, IPC, atlas splitting, asset
  staging, saving, and reload for both image and description creation routes.
- All nine distinct fixture mouth PNGs decoded and displayed with transparent
  corners. Both local walking previews completed: exit stayed hidden and entry
  returned to its anchor. Each saved suite retained 19 distinct sprite mappings,
  including two four-frame walking clips. Real presence IPC acknowledged ordered
  OBS exit/entry commands. Overlay tests separately exercised serialized renderer
  motion, wide-canvas travel, stale audio, disconnects, and presence isolation.
- Creator screenshots were inspected at normal and minimum desktop sizes. The
  minimum window had no horizontal overflow; the primary generation action and
  sticky save control remained available. Image input, generated builder, and
  walking endpoint captures were inspected. Fixture drawings demonstrate software
  behavior, not model artwork quality.

The normal user profile was not opened or changed. Reports and screenshots remain
under the ignored `.qa/` directory: `.qa/smoke.json` (including `characterCreation`)
and `.qa/character-*.png`. The initial plain-tone fake-microphone smoke did not
produce timestamped classifier output; the full rerun with synthetic speech passed.

**NOT RUN:** paid OpenAI API calls, visual consistency/semantic correctness of
real generated sprite sheets, actual OBS recording of the new walking clips,
fresh-install validation, packaging, or release publication for this suite.

Reproduce the completed check:

```powershell
npm run check
$speechFixturePath = (Resolve-Path .qa\lip-sync-speech.wav).Path
node node_modules/electron/cli.js . --smoke-test --character-suite-check --speech-fixture-check "--use-file-for-fake-audio-capture=$speechFixturePath"
```

If the fixture file is absent, create it with
`.\scripts\generate-lip-sync-fixture.ps1`. The character-suite fixture is enabled
only with the smoke flags and isolated test profile; normal generation uses OpenAI.

## October 16 lip-sync implementation checkpoint

The local source and newly built `release/win-unpacked/Voxincarnate.exe` now include
the nine-pose lip-sync mode. These checks cover this implementation; the October 15
Sesame call below predates it and does not validate the new classifier's accuracy.

- `npm run check` passed strict TypeScript checking, **69 tests**, and the production build.
- `npm run pack` produced the Windows x64 unpacked application. The bundled model,
  worklet, third-party notices, and all nine demo drawings were verified in the package.
- The packaged executable passed the isolated fake-input smoke with an original
  Windows Zira speech fixture. During an eight-second sample, 242 timestamped
  articulation updates included eight dominant poses (A/B/C/D/E/F/H/X). This proves
  execution and variation through the real renderer/preload/IPC path, not phoneme accuracy.
- The production UI added the demo through its real action, rendered all nine
  assigned images, retained mappings through binary/viseme mode switches and reload,
  and displayed the closed fallback when X artwork was removed. Screenshots at
  1440 by 960 and 1120 by 740 were visually inspected; labels, pose controls, and
  sticky Save were readable, without horizontal overflow.
- The actual authenticated OBS overlay page in sandboxed Chromium rendered all
  nine poses at 600 by 600, retained zero corner alpha for each, interrupted an
  opening with a closure, and returned to rest on Stop. Rendered PNGs were inspected.
  This is browser-source renderer evidence, not a new recording made in OBS itself.
- A separate packaged tab-only smoke, with no fake media or physical microphone,
  retained visible/hidden capture isolation from unrelated audio and reached
  sustained silence. It also passed the pose UI and overlay rendering checks.
- Regression coverage includes v1 migration/backups, partial and invalid mappings,
  missing/failed images, out-of-order audio clocks, model failures, late cancellation,
  source loss, silence, live sensitivity settings, and gain-recovered quiet audio
  through the actual vendored classifier.

The checks use `.qa/profile`; the normal user profile was not opened or changed.
Reports and screenshots are ignored local artifacts in `.qa/smoke.json`,
`.qa/smoke-tab.json`, `.qa/viseme-*.png`, and `.qa/obs-viseme-*.png`. The speech fixture
was synthesized directly to a file, without recording a person or playing it aloud.

**NOT RUN for the new mode:** a live Sesame speech-quality comparison, independent
listening, an actual OBS audiovisual recording with measured offset, clean-machine
installation, and installer/ZIP release publication. Assistant playback has no added
sync delay. The model is approximate and has not been calibrated for Sesame voices.

To reproduce the speech fixture check from source:

```powershell
npm run check
.\scripts\generate-lip-sync-fixture.ps1
$speechFixturePath = (Resolve-Path .qa\lip-sync-speech.wav).Path
node node_modules/electron/cli.js . --smoke-test --speech-fixture-check "--use-file-for-fake-audio-capture=$speechFixturePath"
node node_modules/electron/cli.js . --smoke-test --tab-capture-only
```

Validation checkpoints on October 15, 2026, from the `iz` working tree. Target: Windows 11 x64, Electron 44.7.2, Node.js 24.12.0. This record distinguishes automated and synthetic checks, the completed live Sesame/OBS test, and remaining installation and compatibility checks.

## Completed checks

- The latest completed `npm run check` passed strict TypeScript checking, 44 automated tests, and the production frontend/main/preload build.
- Real Electron desktop smoke with Chromium fake microphones: the compiled UI selected and saved an input, started capture, loaded the separate AudioWorklet under the production content policy, updated the meter, and stopped capture. The fake input reached approximately -12 dB in the UI.
- The actual embedded-page preload rejected microphone capture before enabling it, enumerated concrete device IDs in the page's own origin, forced the selected ID, and verified it against the actual track settings. Camera requests were rejected. Stop ended existing tracks and subsequent microphone requests were rejected.
- A separate Electron process **without fake media devices** captured a 440 Hz tone from the embedded tab while another window played a 1200 Hz tone. The target exceeded the unrelated tone by approximately 42 dB while visible and 63 dB while hidden. After muting the assistant fixture, the captured peak fell below 0.0003 while the other window kept playing. This establishes local tab isolation for the tested synthetic sources.
- The actual HTTP/WebSocket overlay loaded in a separate sandboxed Chromium window, displayed its artwork, and produced a 600 by 600 PNG whose corner alpha was zero. The PNG was visually inspected. The sample artwork itself retains its opaque background.
- Screenshots at the normal and minimum desktop sizes, plus the character builder, were inspected. Essential input/start controls and the sticky Save action remained accessible. The remaining lower content is reachable by scrolling.
- An earlier smoke checkpoint loaded Sesame's actual public welcome content at `https://app.sesame.com/welcome`. The child view's independent screenshot API returned `UnknownVizError`; that content check used the rendered document text. No voice conversation was performed in that earlier smoke check; the later normal-profile call is recorded below.
- Windows NSIS and ZIP distribution targets built successfully at an earlier packaging checkpoint. The installer is unsigned. That packaged executable passed its tab-only smoke run from a fresh repository-local profile: it seeded its library from bundled artwork, rendered the builder, isolated the two synthetic audio sources, reached sustained silence, and rendered the alpha-transparent overlay. Its report is `.qa/packaged-final/.qa/smoke-tab.json`. These artifacts predate the latest diagnostic and layout changes.

## Live setup checkpoint

The rebuilt `release/win-unpacked/Voxincarnate.exe` was launched with the normal user profile. Sesame's live HTTPS welcome page enumerated 18 real assistant-origin input choices. The user-requested **Analogue 1 + 2** Focusrite input was selected and saved. Assistant-tab capture was active and silent while the site remained at its welcome/Continue step.

That first setup checkpoint confirmed device discovery and saved selection; the later call checkpoint below adds real track and conversation evidence. The user subsequently completed Sesame's Continue step themselves.

In OBS **33.0.0-rc1**, an isolated **Voxincarnate Test** scene was created with:

- **Voxincarnate Avatar Test**: a 600 by 600 Browser Source visibly rendering the avatar.
- **Voxincarnate Sesame Audio Test**: an Application Audio Capture source targeting Voxincarnate.

This established source setup and visible avatar rendering in actual OBS. Later live-response and recording observations are recorded below. Pre-existing scenes and global microphone sources were preserved.

## Live Sesame and OBS recording checkpoint

After the user completed Continue, a Sesame **Maya** call was started in the embedded browser. The studio showed an active call and **Verified input: Analogue 1 + 2 (Focusrite USB Audio)**. The user confirmed hearing the assistant and seeing the OBS avatar move. This is real website/physical-input evidence, separate from the earlier fake-device and oscillator tests.

A read-only overlay WebSocket observation over 45 seconds collected more than 1,200 state updates, including 260 speaking updates and six speaking/idle transitions. The reported level peaked near -13.99 dB, and the avatar returned to idle. A native OBS screenshot showed an open-mouth pose and green activity on the dedicated Voxincarnate audio meter.

A local OBS recording was made and stopped; streaming was not started:

| Recording property | Observed result |
| --- | --- |
| File | `.qa/live-sesame-20261015.mp4` |
| Duration | 176.566 seconds |
| Video | 1920 by 1080, H.264 |
| Audio | 48 kHz, stereo AAC |
| Size | 445,852,384 bytes |
| FFmpeg audio measurement | Mean approximately -25.4 dB; maximum approximately -1.6 dB. |
| OBS log | Approximately 0.2% reported encoding/rendering lag. |
| Visual inspection | `.qa/live-sesame-contact.jpg` contains both open-mouth and closed-mouth poses. |

The recording was retained in the repository's ignored `.qa/` directory, with SHA-256 verification. The recording, browser profiles, and local access tokens are not included in source control or release assets.

The recording contains measurable audio and visible mouth changes. The user reported that the final echo/doubled-voice and microphone-only/assistant-idle checks were all good. This is user-reported live evidence; the recorded soundtrack has not separately been reviewed by listening, and exact audiovisual offset has not been measured. Global microphone sources were preserved, so the mixed recording is not proof that its soundtrack contains only the dedicated assistant source.

The user stopped the test. The app was subsequently observed at **Ready when you are**, with **Capture assistant audio** available, no verified active input, and Sesame back at its Maya/Miles choices with no active call. OBS recording was also confirmed stopped. This establishes visible session/capture cleanup; a separate Windows microphone-use indicator was not verified. The idle app was closed for final packaging.

## Diagnostic fix and build identity

Assistant input discovery now reports adapter readiness, discovery progress, empty-device results, and command/initialization failures instead of leaving an unexplained empty list. The UI retains an error when unrelated browser-status updates arrive; explicit recovery/success can clear it. Device enumeration succeeded after the diagnostic changes were rebuilt into the unpacked application. The original empty-list failure's root cause has **not** been confirmed; the successful retry is not proof of a specific cause.

Version 0.2.1 also recalculates embedded-browser bounds when error or notice banners move the layout. Its packaged smoke check exercises production IPC, preload, React, and DOM to verify that URL/loading-only updates preserve microphone options and errors, while explicit recovery clears the error. The package uses a repository-local electron-builder cache so restricted environments do not require writing to the default user cache.

| Build/check | Scope at this checkpoint |
| --- | --- |
| Latest completed full check | 44 tests, strict types, and production build passed. |
| Live test app in the normal profile | Discovery diagnostics, live Sesame enumeration, verified Focusrite input, an active Maya call, assistant-driven avatar changes, and OBS audio-meter activity were observed. |
| Version 0.2.1 unpacked package | All ten compiled files match the current build. Packaged tab-only smoke passed with no physical microphone access: status UI regression, visible/hidden tab isolation, silence recovery, and 600 by 600 alpha-transparent overlay. Report: `.qa/smoke-tab.json`. |
| Version 0.2.1 NSIS installer and ZIP | Built successfully. Distribution assets are `Voxincarnate-0.2.1-x64.exe`, `Voxincarnate-0.2.1-x64.zip`, and `SHA256SUMS.txt`. |

The normal application profile is separate from the repository-local smoke profile; synthetic checks do not change the user's saved microphone or character.

The final normal-profile relaunch was interrupted when the user stopped Computer Use with Escape. A successful automated packaged smoke check does not establish that final interactive relaunch or a clean-machine installation.

## Reproduce the local checks

```powershell
npm ci
npm run setup
npm run check
npm run smoke
node node_modules/electron/cli.js . --smoke-test --tab-capture-only
```

To include the read-only Sesame welcome check, add `--sesame-page-check` to the fake-microphone smoke command. Local reports and screenshots are written under ignored `.qa/`; these are test profiles, not the normal application library.

The fake microphone flag can affect Chromium display-audio capture as well. Consequently the fake-microphone process deliberately skips tab isolation. The tab-only process refuses fake media and never opens a physical microphone. Do not combine the two results into a claim of physical-device validation.

The smoke renderer uses software offscreen rendering. Chromium sandboxing remains enabled. Codex's Windows process sandbox prevented the Electron runtime from starting normally, so the desktop tests ran outside that outer process sandbox, against repository-local test profiles.

## Character deletion validation (2026-10-16)

`npm run check` passed TypeScript, all 132 automated tests, and the production build. Deletion tests cover persisted active-character fallback, final-character protection, concurrent deletion, failed writes preserving artwork, cleanup failures, revoked image access, and connected overlays clearing their images and smoke without reconnecting or restoring pending image decodes.

After building, `node node_modules/electron/cli.js . --smoke-test --character-delete-check` passed the real renderer/preload/IPC flow in the separate `.qa/character-delete-profile` profile. It verified cancellation, preservation of unsaved character/settings edits when deleting another character, active-character replacement and editor reset, persistence after reload, and final-character protection in both UI and IPC. The test removed only its temporary characters and restored the initial settings. The rendered library and trash controls were inspected in `.qa/deletion-ui.png`; the report is `.qa/character-deletion.json`.

This check used no paid generation requests or physical audio. Connected-source deletion was verified with local WebSocket and generated-renderer tests; a live OBS application deletion check was not run.

## Version 0.3.0 release validation (2026-10-16)

`npm run dist` passed strict TypeScript checking, all 134 automated tests, the production build, and Windows x64 NSIS/ZIP packaging. The added gait regressions verify proportional fitting, transparent padding, and consistent bottom-center frame placement for portrait and landscape canvases. Legacy Python sources passed `python -m compileall -q voxincarnate`; no Python audio runtime check was performed.

The packaged `release/win-unpacked/Voxincarnate.exe` passed deletion UI/IPC checks, tab-only assistant-audio isolation, nine-pose UI and transparent-overlay rendering, and the complete character-creation suite using deterministic local API fixtures. Creation verified source-preserving mouth/face edits, all nine poses, saved/reloaded image and motion mappings, walking, smoke and fall/jump previews, and ordered OBS presence commands. These runs made zero paid API requests and opened no physical microphone. Reports are `.qa/packaged-0.3.0-character-deletion.json`, `.qa/packaged-0.3.0-tab.json`, and `.qa/packaged-0.3.0-character-suite.json`.

All 14 compiled files in the packaged archive matched the production build byte-for-byte; the nine demo PNGs also matched their sources, and the bundled inference assets and third-party notices were present. The ZIP's application archive matched that tested unpacked package. The executable reports product version 0.3.0.0. Distribution assets are `Voxincarnate-0.3.0-x64.exe`, `Voxincarnate-0.3.0-x64.zip`, and `SHA256SUMS.txt`. The executable and installer are unsigned. A normally running app was left open; isolated smoke profiles temporarily used a free overlay port instead of its occupied default port.

## Version 0.3.1 release validation (2026-10-16)

`npm run dist` passed strict TypeScript, all **138 automated tests**, the production build, and Windows x64 NSIS/ZIP packaging. Four new storage regressions cover renaming active and inactive characters, restart persistence, invalid names and IDs, concurrent writes, and failed commits without losing saved data or artwork.

The editor groups the builder directly beneath a shorter preview, independently of the audio/OBS inspector. Rendered checks at 1920x1080, 1440x960, and 1120x740 verified a 24-pixel preview-to-builder gap, responsive fields, accessible artwork/alignment controls, and the sticky Save action. The inline library rename form passed Enter/Escape/Cancel, blank-name rejection, error recovery, focus return, and preservation of unsaved character and audio settings.

A separate isolated Electron harness loaded the **actual packaged main, preload, and renderer from app.asar**, using the real trusted IPC, LibraryStore, and overlay server. At 1440x960 and 1120x740 it verified editor spacing, active/inactive renaming, trimming, unchanged IDs/artwork/OBS URLs, and that only names were saved while other draft edits stayed unsaved. A second process loaded the same isolated profile and restored both names. This harness used the installed Electron runtime, rather than launching the packaged executable. Reports are `.qa/windows-v031/packaged-features.json` and `.qa/windows-v031/packaged-feature-restart.json`.

The **packaged executable itself** passed tab-only assistant-audio isolation, nine-pose UI, and transparent-overlay rendering with a separate isolated smoke profile. No physical microphone was opened and no paid generation requests were made. Its report is `.qa/windows-v031/exe-smoke/.qa/smoke-tab.json`.

All 14 compiled files and nine bundled demo PNGs matched their sources; inference assets and third-party notices were present. The portable ZIP's executable and application archive matched the tested unpacked package byte-for-byte. The executable reports product version 0.3.1.0. Distribution assets are `Voxincarnate-0.3.1-x64.exe`, `Voxincarnate-0.3.1-x64.zip`, and `SHA256SUMS.txt`; checksums and package verification are recorded under `.qa/windows-v031/`. Packages are unsigned and have no automatic updater. Clean-machine installation and a new live physical audio/OBS session were not run for this release.

## Mouth threshold return-to-idle fix (2026-10-16, source build)

The visible mouth threshold now gates both speech activation and the return to
rest, with the existing mouth hold covering brief pauses. Previously the hidden
closing threshold stayed 7 dB below the slider, so a -38 dB setting could remain
Speaking indefinitely at -42 dB. Existing libraries with separate closing
thresholds load without a migration and use the visible threshold at runtime.

`npm run check` passed TypeScript checking, all 143 automated tests, and the
production build. Regressions cover nonzero background noise, hold timing and
reset, live threshold edits, direct/browser capture returning to X despite fresh
open-mouth predictions, and saving/reloading equal thresholds while retaining
legacy library support.

An isolated, hidden Electron harness loaded the compiled main, preload, renderer,
real audio worklets, and local lip-sync model. With production attack/release,
60 ms hold, and legacy -38/-45 dB settings, a generated Web Audio stream at -30 dB
showed Speaking; lowering it to -42 dB showed Idle and the correct closed/X image
in both binary and viseme modes. The actual OBS browser pages selected the same
rest artwork. Capture remained running with a live track, and louder input
reopened the mouth. The real UI slider saved equal thresholds to disk and retained
them after reload. Screenshots were inspected visually. Evidence is recorded in
`.qa/mouth-threshold/rendered.json`, `binary-idle.png`, and `viseme-idle.png`.

This used synthetic local audio, without a physical Focusrite input or the OBS
application. It validates the source build; the installed release was not updated.

## Version 0.3.2 release validation (2026-10-16)

`npm run dist` passed strict TypeScript checking, all 143 automated tests, the
production build, and Windows x64 NSIS/ZIP packaging. The mouth threshold now
controls the return to idle without the hidden 7 dB closing gap. New settings
default to a 250 ms mouth hold, including the detector's invalid-value fallback;
existing saved hold durations are retained.

An isolated Electron harness loaded the actual packaged main, preload, renderer,
worklets, and local model from `release/win-unpacked/resources/app.asar`. Generated
audio at -30 dB showed Speaking, then -42 dB returned to Idle and closed/X artwork
with a -38 dB threshold and a legacy -45 dB close setting. Binary and viseme modes,
their actual OBS browser pages, capture continuity, louder-input reopening, and
equal-threshold UI save/reload all passed. A fresh profile initialized through the
packaged LibraryStore persisted and displayed the 250 ms default. The package
metadata and UI report 0.3.2. Reports are
`.qa/mouth-threshold/packaged-rendered.json` and
`.qa/mouth-threshold/packaged-fresh-default.json`; their screenshots were inspected.

The packaged executable itself passed tab-only assistant-audio isolation,
nine-pose UI, and transparent-overlay checks in a separate isolated profile.
Its report is `.qa/windows-v032/exe-smoke/.qa/smoke-tab.json`.

All 14 compiled files and nine demo PNGs matched the package byte-for-byte;
bundled inference assets and third-party notices were verified. The portable ZIP's
executable and application archive matched the tested unpacked application.
The executable reports product version 0.3.2.0. Distribution artifacts are
`Voxincarnate-0.3.2-x64.exe`, `Voxincarnate-0.3.2-x64.zip`, and `SHA256SUMS.txt`;
artifact verification and checksums are under `.qa/windows-v032/`.

These checks used synthetic local audio without a physical microphone or paid
generation requests. A new live Focusrite/assistant/OBS session and clean-machine
installation were not run. Packages remain unsigned and have no automatic updater.

## October 17 selectable entrance and exit animations

The source builder now supports multiple entrance and exit choices from the three
existing effects: walk on/off, jump in/out, and a puff of smoke. New character kits
retain every selected choice. Saved characters can generate only their missing
choices without rebuilding speech artwork. Active choices remain compatible with
the existing studio and OBS playback; switching effects retains each clip's
artwork, direction, alignment, and timing. Inactive gait assets are validated and
retained through save/reload. Sound selections are preserved.

`npm run check` passed TypeScript, **157 tests**, and the production build. The
real Electron renderer/preload/IPC character suite passed with deterministic local
API fixtures and the existing synthetic speech fixture. It verified:

- Creation with all three entrance and all three exit types, plus rejection of an
  empty entrance selection and persistence of all six choices.
- Adding local effects with no image API requests, and generating just one missing
  walk without requesting the unselected direction.
- Adding four missing choices to an existing character with exactly two walking
  requests, no new speech/detection requests, and preservation of the current clips
  and all saved speech images until an explicit Save changes.
- Rejection of already available choices, rollback when the second walking request
  fails, cancellation of an active request, and removal of discarded staged images
  while retaining saved artwork.
- Choosing the added walking clips, saving, and restoring all choices after reload.
- Rendered creation and missing-animation controls at 1440 × 960 and 1120 × 740,
  with no horizontal overflow. The UI detector reported no findings.

The report is `.qa/smoke.json`, under `characterCreation`; screenshots include
`.qa/character-creator-animations-minimum.png` and
`.qa/character-missing-animations-desktop.png`. These checks made no paid API calls
and used no physical microphone. Live generated-art quality and physical OBS
validation were not rerun. Distribution packages were not rebuilt for this feature.

## October 17 on-air animation choices

The on-air section now has separate Entrance and Exit buttons for all three core
effects. Each button is enabled only when its direction and effect exist for the
selected character. Characters with no animations retain the section with six
disabled buttons and guidance to add animations; unsaved drafts and edits also
disable on-air controls. The trusted desktop command checks saved availability
before changing live presence. Commands carry their requested effect through the
shared studio/OBS animator, use the associated saved clip and sound, and preserve
configured default clips. OBS preloads inactive gait artwork for immediate playback.

TypeScript, the production build, and **160 tests** passed. Coverage includes all
three explicit effects in both directions, the serialized animation factory, real
overlay-page rendering of inactive gait choices, command validation, and ignored
renderer attempts to spoof presence. The UI detector reported no findings.

`node node_modules/electron/cli.js . --smoke-test --motion-sound-check` passed the
actual renderer/preload/IPC flow and a real Electron overlay browser in the isolated
`.qa/motion-sound-profile` profile. It verified a character with walking and smoke:
four enabled buttons, two disabled jump buttons, correct walking sprite selection,
matching footsteps/smoke audio without studio duplication, and preserved saved
defaults. It also checked unsaved edits, different entrance/exit availability,
no-animation characters, unavailable-command rejection, and snapshot sound handling.

The report is `.qa/motion-sounds.json`, including `onAirAnimations`. Rendered controls
were inspected at 1440 and 1120 pixels wide in `.qa/on-air-animations-1440.png` and
`.qa/on-air-animations-1120.png`, with no horizontal overflow. These checks made no
paid API requests and used no physical microphone or OBS application. Distribution
packages were not rebuilt for this change.

## Local controls, Stream Deck, and global hotkeys (October 17, 2026)

`npm run check` passed strict TypeScript, all **168 tests**, the production app
build, and the official Elgato CLI's plugin validation/package step. Control
regressions cover command allowlists, state guards, independent credential
persistence, corrupted optional settings, authenticated HTTP/WebSocket access,
browser-origin/Host rejection, body limits, hotkey conflict rollback, control-port
collision rollback, interruptible startup, and plugin reconnect without replay.

`npm run smoke:controls` passed the actual Electron renderer/preload/main flow in
`.qa/control-profile`. It verified direct capture and background assistant-tab
capture using a fake microphone and local tone, waited for assistant microphone
discovery, exercised all six explicit animation effects, preserved saved motion
defaults, rejected unsaved changes and refresh during capture, and confirmed
native global-hotkey registration, suspension while editing, resumption on close,
and duplicate-save recovery. Status does not expose either connection token.

Settings were rendered and inspected at 1440 and 1120 pixels wide, including a
conflict saved while scrolled to the bottom. Errors and Save remain visible in the
sticky header. The Stream Deck property inspector was rendered at 360×650 in
connected motion and disconnected states. Captures include `.qa/controls-1440.png`,
`.qa/controls-1120.png`, `.qa/controls-hotkeys-1120.png`,
`.qa/controls-conflict-1120.png`, and `.qa/streamdeck-inspector-*.png`. A separate
finish review confirmed its requested fixes resolved. The UI detector returned no
findings in degraded regex mode; computed-style/contrast validation was not
provided by that detector.

`npm run smoke:streamdeck` passed the built official-SDK plugin against a simulated
Stream Deck WebSocket host and an actual localhost API server. It checked SDK
registration, pairing/global settings, capture key feedback from app state,
specific-character animation targeting, unsaved guards, disconnect feedback,
reconnection without replay, and exclusion of credentials from individual key
settings. Its report is `.qa/streamdeck.json`.

A separate Windows x64 directory package was built in
`.qa/control-release/win-unpacked` without replacing existing release artifacts.
Running its `Voxincarnate.exe --smoke-test --controls-check` passed the same Electron
checks, including the bundled plugin installer and inspector assets. Its report is
`.qa/controls-packaged.json`; the source-run report is `.qa/controls.json`.
The embedded plugin matches the standalone `.streamDeckPlugin` artifact, and the
application archive excludes control credentials, QA profiles, and plugin logs.

These runs made no paid generation requests, did not install the plugin into the
user's Stream Deck application, and did not publish a release. Physical Stream
Deck presses, real microphone/hotkey injection, live assistant calls, OBS behavior,
and clean-machine installation for these controls remain **NOT RUN**.

## Version 0.4.0 release checks (October 17, 2026)

The release includes the motion choices, missing-animation generator, WAV effects,
on-air controls, local API, Stream Deck plugin, global hotkeys, and placement of
the entrance/exit buttons above **Take it to OBS**. The UI now shows its busy state
immediately while a clicked control is dispatched to the main process; the shared
command handler continues to enforce readiness and concurrency checks.

Strict TypeScript, all **168 automated tests**, the production build, and official
Elgato plugin validation/package passed. The built plugin passed its simulated
host checks. Windows x64 NSIS and portable ZIP assets are built in
`release/v0.4.0`, with the standalone plugin and SHA-256 checksums alongside them.

The packaged control smoke passed background capture, microphone discovery, all
six animation actions, hotkey registration/conflict recovery, and settings and
property-inspector rendering. The packaged motion/sound smoke passed WAV imports,
persistence, studio and overlay playback, interruption, no snapshot replay,
per-direction animation availability, saved-default preservation, and the updated
1440/1120 layouts.

For the full lip-sync and character suite, the release check uses the existing
prerecorded synthetic speech fixture with `--speech-fixture-check` and
`--use-file-for-fake-audio-capture=<absolute path to .qa/lip-sync-speech.wav>`.
This supplies speech to the classifier rather than treating a constant fake tone
as a spoken input. The check produced 241 timestamped articulation updates and
eight dominant mouth poses during its eight-second observation, and passed the
fixture-only creation, missing-animation, failure, cancellation, and preservation
checks. It is execution/variation evidence, not a phoneme accuracy measurement.

Package verification compares compiled files, the model/notices, sounds, and
bundled plugin with their source build; the installer and portable ZIP are checked
against the tested executable and application archive. Private QA profiles,
connection settings, and plugin logs are excluded. No paid generation, physical
Stream Deck/microphone session, live assistant/OBS session, or clean-machine
installation is claimed for this release.

## Not run

- Google/Apple sign-in, interruption, and long-session reconnection. A live Maya call and verified Focusrite input were observed as described above.
- Physical input unplug/replug, Bluetooth behavior, Windows microphone privacy denial, and a separate Windows microphone-use-indicator check.
- Independent listening to the recorded soundtrack for content/duplication, and measurement of exact audiovisual offset. The user reported the live echo and microphone-only idle checks passed; OBS meter activity and avatar movement were observed, and the recording was inspected visually.
- OBS scene-change/hide-show recovery during the real call and controlled compositing over a contrasting layer.
- Clean-machine installer installation/uninstallation, code signing, SmartScreen reputation, or automatic updates.
- ARM64 or Windows 10 compatibility, multi-speaker separation, and phoneme-based animation.

These checks remain acceptance tasks. The application implements the requested routes; the synthetic checks do not establish that every assistant website, physical device, or OBS setup will work.

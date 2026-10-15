# Windows desktop evaluation and implementation plan

Assessment date: October 15, 2026. Starting branch: `iz`. Original tracked revision: `616d363f2e453acd8f3d13f818fe4c2543112720`.

This document preserves the evaluation and staged plan presented before implementation. **Original assessment** and **Planned stages** describe that starting point and intended delivery. **Implemented state** describes the code now present. The [delivery validation record](desktop-validation.md) distinguishes automated checks, the completed live Sesame/Focusrite/OBS test, and remaining installation and compatibility checks.

## Goals and scope

Deliver a Windows 11 x64 application with:

1. A persistent character library and builder accepting one or more closed-mouth and open-mouth images.
2. Direct mode: a selected recording input drives the avatar.
3. Assistant mode: a selected microphone or single-speaker source feeds an embedded assistant website, and that browser's output drives the avatar.
4. Transparent avatar output usable as an OBS Browser Source.
5. A repeatable desktop build, automated regression coverage, Windows distribution targets, and an explicit manual acceptance checklist.

Sesame is the selected first assistant website. Site authentication and the voice session remain website operations. The initial delivery does not include voice cloning, lip/phoneme synthesis, a paid assistant API, a virtual microphone driver, an OBS plugin, automatic background removal, or public overlay hosting.

## Original assessment

### Keep the two-pose strategy

Amplitude-driven switching between supplied mouth poses is appropriate for a lightweight talking avatar. It has small compute requirements, works with arbitrary speaker audio, preserves the user's artwork, and does not require transcription or an AI service. Multiple frames within a pose add movement without increasing the audio-routing problem.

Audio energy indicates when the avatar should speak; it cannot determine phonemes, emotion, or true lip synchronization. A complete animation/model overhaul would add complexity beyond the requested result. The useful overhaul is in application structure, capture routing, persistence, and rendering reliability.

### Starting implementation and defects

The original launch chain is `app.py` -> `voxincarnate/__init__.py` -> `voxincarnate/voxincarnate.py`. It prompts in a terminal, captures a hardcoded two-channel PyAudio stream, normalizes peaks over rolling minimum/maximum values, and broadcasts one amplitude to every WebSocket client.

| Original evidence | Effect | Planned correction |
| --- | --- | --- |
| `voxincarnate/voxincarnate.py:88-95` fixes two channels and the configured sample rate. | Some mono devices cannot open; stream capabilities are not negotiated. | Use Chromium media capture with a selected device and its negotiated stream format. |
| `voxincarnate/voxincarnate.py:113-130` uses signed 16-bit peaks and rolling min/max scaling. | Small background variation can become a large normalized signal; `abs` at the minimum signed sample is also problematic. | Compute floating-point channel energy, then use a dB threshold, gain, attack/release smoothing, hysteresis, and a close hold. |
| `voxincarnate/voxincarnate.py:198` sends only one `amplitude`. | No character identity, running/stale state, sequence, or initial profile contract. | Send bounded per-character state with timestamp and sequence, and explicit idle snapshots. |
| `voxincarnate/voxincarnate.py:233` binds `0.0.0.0:5678`. | The legacy broadcaster is reachable beyond the local machine when network policy permits. | Bind the desktop overlay to loopback and require its persistent token and expected Host/Origin. |
| `overlays/talking_mouth.html:39,58,116` starts with `currentState='closed'`, then refuses the same state during initialization. | No image is visible until a later mouth transition. | Decode artwork and render an explicit initial closed pose. |
| `overlays/talking_mouth.html:58,131-135` drops a crossing inside its 100 ms throttle but advances the previous amplitude. | A mouth can stay open through sustained silence, or closed through sustained speech. | Keep desired state and render it each animation frame; never discard a transition because of a throttle. |
| `overlays/talking_mouth.html:54-75` chooses a frame only on a state change. | Extra images do not cycle during sustained speech or idle. | Cycle ordered frames independently within the active pose. |
| `overlays/talking_mouth.html:79-116` creates images without awaiting decoding or handling failure. | Images may be switched before ready; missing assets lack a useful application error. | Validate imports, preload decoded assets, and retain a usable pose fallback. |
| `overlays/talking_mouth.html:82-93,120` hardcodes artwork and the socket address. | There is one fixed character and no builder/profile. | Managed asset references and stable per-character HTTP URLs. |
| `overlays/talking_mouth.html:142-147` reconnects by reloading the page after five seconds. | Reconnection repeats blank startup and retains stale animation until the reload. | Reconnect the socket with backoff, receive a fresh snapshot, and idle immediately after loss. |
| `README.md` at the original revision documents terminal Python setup and local-file overlays. | No desktop installation or embedded-browser workflow exists. | Document the desktop workflow and retain a separate legacy path. |

A read-only harness executing the actual original overlay script reproduced both major rendering bugs: initial silence produced zero visible images; a speech ending 50 ms after opening left the open image visible through subsequent silence.

The seven active bundled sprites are 400 x 400 RGBA PNGs and can seed the initial managed character. Their existing opaque pixels remain part of the images. `scripts/compress_images.py` resizes to a fixed square; that helper is not suitable as the builder's alignment model.

The working tree also contained untracked `config/characters.json`, `voxincarnate/audio.py`, and `voxincarnate/configuration.py`. They describe a prospective multi-character/audio design, but tracked startup did not import them and their port 8765 differed from the active overlay's 5678. They were treated as pre-existing user work and left unchanged. The desktop does not silently adopt those device assumptions or schemas.

## Architecture decision

### Selected: Electron and TypeScript

Use Electron for a trusted local studio UI and a separate sandboxed `WebContentsView` containing the assistant website. Use React for the editor, a narrow preload bridge for native operations, Web Audio/AudioWorklet for level analysis, and a small loopback HTTP/WebSocket server for OBS.

The important feasibility question is isolated assistant audio. Electron's session media handler can provide a `WebFrameMain` as an audio source, capturing that tab's `webContents`; `enableLocalEcho` preserves normal playback. The handler must validate the requesting frame. This gives the project a documented route to embedded-tab analysis without mixing in desktop audio. [Electron session media capture](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts).

The assistant page receives no Node integration or studio command bridge. Its own persistent session, sandboxing, context isolation, and enabled web security separate it from the application UI. Electron documents the view API and these renderer settings. [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [WebPreferences](https://www.electronjs.org/docs/latest/api/structures/web-preferences).

| Option | Assessment for this project |
| --- | --- |
| Package the existing Python server with a desktop wrapper | Preserves more legacy code, but still requires an editor, embedded browser, browser-output routing, persistence, and lifecycle coordination across runtimes. Packaging alone leaves the core workflow incomplete. |
| Tauri/WebView2 | A potentially smaller desktop shell. Its exact embedded-site microphone selection and isolated browser-output capture need a separate feasibility prototype; that uncertainty outweighs package-size benefit for the first release. |
| Qt/Python with a browser widget | Reuses Python and offers native desktop controls, but browser audio routing/site compatibility remain feasibility work alongside Python/browser distribution. |
| Electron/TypeScript | Larger runtime, but one Chromium media model for editor capture and the embedded assistant, documented tab capture, and a shared web renderer for OBS. Selected for the first implementation. |

This is a task-specific decision, not a claim that Electron is the smallest or universally optimal framework. Revisit it if measured installer/runtime cost becomes more important than embedded browser flexibility.

### Data and audio paths

```text
Direct mode:
selected recording input -> Web Audio RMS -> envelope detector -> avatar state

Assistant mode:
selected recording input -> assistant website voice connection
assistant tab playback -> isolated tab capture -> RMS -> detector -> avatar state

Output:
avatar state + saved character -> local HTTP/WebSocket overlay -> OBS Browser Source
assistant playback -> separate OBS Application Audio Capture, if desired
```

Raw audio is processed locally and does not cross desktop IPC or the overlay socket. In assistant mode, the website receives the selected input through its normal voice connection. Image imports remain local. A silent analyzer sink prevents duplicate playback from the analysis graph.

### Character and session model

Each character has a stable UUID, name, canvas dimensions, ordered closed/open sprite arrays, and frame interval. Each sprite has an immutable UUID asset filename, display name, x/y canvas offsets, and scale. Images render at natural size around the canvas center. At least one image per pose is required before saving.

Imports are decoded by Electron, checked for PNG/JPEG signature, limited to 16 MB and 4096 pixels per source dimension, and normalized to PNG. Managed files are copied into `userData/characters/<character-id>/assets/`. The manifest has an explicit version, strict fields/ranges, a persistent overlay token, and atomic writes. Corrupt manifests are reported and preserved, with a recovery-copy attempt.

Settings contain the active character, mode, independent direct/browser device selections, assistant URL, overlay port, and detector settings. Character appearance is reusable across modes. The initial desktop model activates one character/audio route at a time; it is not a multi-speaker mixer.

## Planned stages

### 1. Establish feasibility and preserve the starting state

- Confirm `iz`, inspect the original launch chain, and inventory dirty/untracked work.
- Reproduce the original overlay's blank/stuck states before replacing its behavior.
- Verify the supported Electron tab-capture API and OBS transparent Browser Source contract.
- Use a local oscillator website to exercise embedded-tab capture independently of an assistant account.
- Treat live Sesame compatibility as a separate acceptance condition. Resolve isolated capture before calling assistant mode complete.

Deliverable: architecture choice and explicit evidence boundaries. Gate: distinguish tab output from microphone input and broad system loopback.

### 2. Create the desktop shell and persistent character builder

- Add pinned dependencies, TypeScript checking, production bundling, and an Electron entry point.
- Build the character list, new/edit flow, per-pose image import, ordering, canvas size, alignment, scale, and frame interval.
- Keep Save visible in the top bar; block starting unsaved/invalid characters and protect unsaved edits when leaving them.
- Seed the first character by copying bundled artwork into managed storage.
- Preserve IDs/URLs after edits, moving original image files, and app restarts.

Deliverable: reviewable character workflow. Gate: a closed/open pair survives restart; malformed/oversized inputs and invalid asset references fail clearly.

### 3. Implement direct audio and the envelope detector

- Enumerate recording endpoints after explicit Enable/refresh and request an exact selected device.
- Compute floating-point RMS across channel energy without phase cancellation; avoid rolling min/max amplification of background noise.
- Implement dB sensitivity, gain, attack/release smoothing, a lower close threshold, and close hold using elapsed sample time.
- Keep real-time work in an AudioWorklet and publish only bounded level/speaking state at about 30 Hz.
- Stop tracks/contexts on Stop, cancellation, device loss, worklet error, and stalled capture. Publish final silence.

Deliverable: input animation with visible level/status. Gate: test noise, clipping, phase-inverted stereo, timing, cancellation, and final idle; manually confirm a real input separately.

### 4. Integrate the Sesame browser and selected microphone

- Open Sesame in a dedicated persistent session; permit HTTPS and local HTTP navigation.
- Discover device IDs inside the website's origin rather than reusing studio-origin IDs.
- Install the adapter at document start. Preserve ordinary constraints, enforce the exact selected device for top-level audio requests, and verify actual track settings.
- Keep native command APIs out of remote content; accept only bounded status/device diagnostics.
- Permit audio input after explicit enable/selection; deny remote camera, screen capture, and iframe voice requests.
- Stop active and late-arriving tracks on input changes/Stop. Reload the document when stopping browser mode so page-owned/cloned tracks cannot retain the voice connection.

Deliverable: Open website -> Enable/refresh -> select input -> Save -> Capture assistant audio -> start website voice call. Gate: confirm the exact selected input or fail clearly. Authentication stays a website operation; do not bypass identity-provider restrictions or transfer cookies.

### 5. Capture only the assistant tab's output

- Grant display media only to the trusted studio's main frame and only for the known assistant tab.
- Use that tab as the video/audio source; keep the required video track alive but analyze only audio.
- Preserve normal assistant playback and mute the analysis sink.
- Handle missing audio, ended tracks, render-process loss, permission errors, and stalled graphs without leaving a speaking avatar.

Deliverable: assistant-output animation. Gate: local oscillator capture confirms the native media route; real Sesame conversation and unrelated desktop-audio isolation remain separate manual checks.

### 6. Provide the transparent OBS contract

- Serve `http://127.0.0.1:48241/overlay/<character-id>?token=<token>` and managed assets from the same local origin.
- Persist UUID/token/port, bind loopback, enforce Host/token and WebSocket Origin checks, and expose no control/microphone API through the output.
- Return a closed initial pose, decoded artwork, and a current state snapshot. Cycle frames deterministically without discarding fast speech endings.
- Reconnect with backoff and fresh snapshots; close on disconnection and stale input.
- Bound per-client buffering so a slow source cannot stall other clients.
- Provide Copy OBS URL and canvas dimensions; keep editor controls and diagnostics out of the scene.

Deliverable: video-only transparent Browser Source. Gate: authenticated source/asset and render-script regressions pass; verify alpha, scene changes, hide/show, and sound timing in real OBS separately. OBS documents viewport/FPS, transparent CSS, and source lifecycle behavior in its [Browser Source guide](https://obsproject.com/kb/browser-source).

Assistant sound is an independent OBS Application Audio Capture source, with duplicate desktop capture avoided. See the [Application Audio Capture guide](https://obsproject.com/kb/application-audio-capture-guide).

### 7. Package and verify Windows delivery

- Provide `npm ci`, `npm run setup`, and `npm start` as the development path.
- Make `npm run check` run types, tests, and build; provide the Electron smoke fixture separately.
- Configure electron-builder for Windows x64 NSIS/ZIP, bundled seed artwork, and retained user data on uninstall.
- Check the unpacked app and, separately, a clean install/relaunch with its own profile.
- Report actual artifact/check results. Build configuration is not a produced installer; a produced installer is not a clean-install test.

Deliverable: local distribution artifacts and a validation record. Signing, public release publication, and auto-updates require separate configuration and are not implied by an unsigned local build.

## Implemented state

The current desktop tree implements the editor, managed library, direct audio engine, envelope detector, Sesame-default browser/input adapter, restricted embedded-tab capture route, and token-protected OBS output. Code is split across `desktop/main.ts`, `preload.ts`, `renderer/`, `assistant-preload.ts`, `browser-adapter.ts`, `audio/`, `library.ts`, and `overlay.ts`.

Package scripts define setup/start, typecheck/tests/build, Electron smoke, unpacked packaging, and NSIS/ZIP distribution. Definitions alone do not assert that every packaging command succeeded.

The latest completed `npm run check` passed 44 tests, strict types, and the production build. Coverage includes detector behavior, capture cancellation/device loss/stall handling, assistant-device verification and late streams, storage and corrupt-manifest preservation, HTTP/WebSocket boundaries, fresh/stale state, and executing the actual overlay renderer for closed startup, fast speech ending, disconnect idle, and an initial animation timestamp preceding initialization.

Input-discovery diagnostics now show adapter readiness, progress, empty-device results, and command failures; unrelated browser-status updates no longer erase an existing error. The original empty-list failure's root cause is unconfirmed. In the rebuilt unpacked app's normal profile, Sesame's HTTPS page enumerated 18 real assistant-origin inputs and the requested Analogue 1 + 2 Focusrite input was selected/saved. The user then completed Continue; an active Maya call showed **Verified input: Analogue 1 + 2 (Focusrite USB Audio)**. The user confirmed hearing the assistant and seeing the OBS avatar move.

Actual OBS 33.0.0-rc1 setup includes a Voxincarnate Test scene, a rendering 600 by 600 Voxincarnate Avatar Test Browser Source, and Voxincarnate Sesame Audio Test Application Audio Capture targeting the app. A native screenshot showed an open-mouth pose and green dedicated-source meter activity. A 45-second read-only overlay observation collected more than 1,200 updates, 260 speaking updates, six transitions, a peak near -13.99 dB, and a return to idle.

A stopped 176.566-second local OBS recording at `.qa/live-sesame-20261015.mp4` contains 1920 by 1080 H.264 video and 48 kHz stereo AAC audio. Its contact sheet shows open/closed poses; audio measurements confirm a non-silent track. The user reported the final echo/doubled-voice and microphone-only idle checks were all good. The app was subsequently observed idle, with no verified active input and Sesame back at its voice choices; OBS recording was stopped. A Windows microphone-use indicator and exact audiovisual offset were not separately verified. Pre-existing scenes/global microphone sources were preserved, so the mixed recording does not prove soundtrack isolation. Streaming was not started.

Version 0.2.1 packages the diagnostics, browser-bounds adjustment when banners move the layout, and a production-renderer smoke regression for error/input persistence and explicit recovery. All ten compiled files match the unpacked package; its tab-only smoke passed without physical microphone access. Windows x64 NSIS and ZIP artifacts were built successfully. The [delivery validation record](desktop-validation.md) contains detailed recording, build, and evidence boundaries. The live call and recorded output add evidence beyond synthetic fixtures; they do not establish clean installation, every audio-routing condition, or complete lifecycle verification. The final normal-profile relaunch was interrupted by the user's Escape key and remains unverified.

## Acceptance checklist and remaining evidence

| Scenario | Expected result | Evidence required |
| --- | --- | --- |
| Import transparent closed/open artwork and several frames | Pose defaults, ordering, offsets, scale, and frame interval are reviewable. | Rendered desktop interaction with user artwork. |
| Save and restart | Artwork/settings persist; OBS URL is identical. | Restart using the same real application profile. |
| Speak, pause briefly, then stop | Threshold/hold follow speech; final silence closes the mouth. | Physical microphone test; recorded comparison if timing is critical. |
| Unplug input, deny permission, or cancel startup | Error/idle without leaked recording streams. | Automated lifecycle coverage plus Windows device/permission checks. |
| Choose Sesame microphone and begin voice | Requested physical source is confirmed; assistant responses animate. | Observed: active Maya call, verified Focusrite input, user-confirmed audible assistant/OBS movement, and speaking/idle states. |
| Play unrelated desktop audio | It does not drive the avatar in assistant mode. | Simultaneous tab, microphone, and desktop audio test. |
| Stop assistant mode | Analysis and the page's microphone/voice session end. | Observed after user stopped: studio idle, no active verified input, Sesame back at voice choices. Separate Windows use-indicator check remains. |
| Add Browser Source over a contrasting OBS layer | Only supplied artwork appears; transparent regions remain transparent. | Real 600 by 600 OBS source and recorded open/closed poses observed. Controlled contrasting-layer compositing remains outstanding. |
| Change scenes/hide source/restart app | Closed initial pose and resync without recopying URL. | Actual OBS lifecycle test. |
| Capture assistant sound in OBS | Correct sound, no duplicate capture, acceptable mouth/audio alignment. | Dedicated meter activity and non-silent recording observed. User reported no live echo/duplication or microphone-only mouth activity. Independent recorded listening and exact offset measurement remain. |
| Install NSIS on clean Windows 11 x64 profile | Launch, assets, audio, and relaunch work without development tooling. | Clean-install run; building an installer is insufficient. |

## Known limitations and follow-up decisions

- Assistant compatibility depends on current site authentication/media behavior. Providers may refuse embedded sign-in. The adapter supports ordinary main-frame requests; it is not a security boundary against the page's JavaScript or a guarantee for every future site implementation.
- One character/audio route is active at a time. Other saved characters' OBS URLs render idle instead of acting as simultaneous speakers.
- There is no phoneme model or automatic artwork generation/background removal. PNG transparency preserves alpha already present in the image.
- The OBS URL supplies animation only. Separate sound routing requires an actual recording check.
- The server reports a port conflict instead of silently changing the OBS URL. The UI does not offer live port changes.
- No signing certificate, automatic updater, virtual audio driver, or native OBS plugin is bundled. Distribution packages are published separately through GitHub Releases.
- Reconsider deeper animation models, multi-character routing, import/export bundles, or alternate frameworks after the live Windows/Sesame/OBS workflow has measured evidence and user feedback.

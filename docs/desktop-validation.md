# Windows desktop validation

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

## Not run

- Google/Apple sign-in, interruption, and long-session reconnection. A live Maya call and verified Focusrite input were observed as described above.
- Physical input unplug/replug, Bluetooth behavior, Windows microphone privacy denial, and a separate Windows microphone-use-indicator check.
- Independent listening to the recorded soundtrack for content/duplication, and measurement of exact audiovisual offset. The user reported the live echo and microphone-only idle checks passed; OBS meter activity and avatar movement were observed, and the recording was inspected visually.
- OBS scene-change/hide-show recovery during the real call and controlled compositing over a contrasting layer.
- Clean-machine installer installation/uninstallation, code signing, SmartScreen reputation, or automatic updates.
- ARM64 or Windows 10 compatibility, multi-speaker separation, and phoneme-based animation.

These checks remain acceptance tasks. The application implements the requested routes; the synthetic checks do not establish that every assistant website, physical device, or OBS setup will work.

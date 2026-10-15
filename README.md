# Voxincarnate

Voxincarnate is a Windows desktop studio for talking avatars. Build a character from closed-mouth and open-mouth images, animate it from an audio input or an embedded voice-assistant website, and add the transparent animation to OBS as a Browser Source.

The first release target is **Windows 11 x64**. The desktop application uses Electron, TypeScript, React, and Web Audio. The original Python application remains available for legacy overlays.

The [desktop evaluation and implementation plan](docs/desktop-plan.md) records the original `iz` branch assessment, architecture decision, delivery stages, and acceptance checklist. The [validation record](docs/desktop-validation.md) distinguishes automated checks, the completed live Sesame/Focusrite/OBS test, and remaining installation and compatibility checks.

## Download for Windows

Download the Windows x64 installer or portable ZIP from [GitHub Releases](https://github.com/rndmzd/voxincarnate/releases/latest). Run the installer, or extract the ZIP and open `Voxincarnate.exe`. Keep the app open while using its OBS source. Packages are currently unsigned.

## Run from source

Use Node.js 24 and npm on Windows. The frontend build requires Node.js 20.19+ or 22.12+; Node.js 24 is the development baseline.

```powershell
npm ci
npm run setup
npm start
```

`setup` downloads the pinned Electron runtime when necessary. `start` also runs setup and builds the application. Run these commands from the project directory. The desktop application does not require Python or a virtual audio cable.

## Build a character

1. Choose **New character**, or select an existing character and choose **Edit character**.
2. Enter a name and canvas dimensions.
3. Add at least one image under **Closed mouth** and at least one under **Open mouth**.
4. Select individual images to adjust their horizontal offset, vertical offset, and scale. Use **Move earlier** to change frame order and adjust the frame interval to control cycling.
5. Use **Save changes** in the top bar before starting audio.

Imports accept PNG and JPEG, up to 16 MB and 4096 pixels per dimension, with up to 24 files per import. A saved character supports up to 64 images per mouth pose. Imported files are decoded, normalized to PNG, and copied into application storage; moving the original files afterward does not break the character.

Use transparent PNGs for a cutout avatar. The overlay canvas is transparent, but opaque pixels already in an image remain visible. The bundled sample sprites retain their image backgrounds; the application does not automatically remove them. Images use their natural pixel dimensions, centered on the character canvas, with each frame's saved offset and scale.

The mouth animation follows audio energy. It switches and cycles between the supplied pose frames; it does not generate phonemes, infer expressions, or create additional artwork.

## Direct audio mode

1. Choose **Direct audio**.
2. Click **Enable / refresh**, then select the desired audio input.
3. Save changes and click **Start audio**.
4. Adjust the mouth threshold, gain, and mouth hold as needed, then save the settings.

The app analyzes that input without playing it back. A microphone or another Windows recording endpoint can be selected. Capturing a separate application's sound directly requires that sound to be exposed as a recording input, such as an already configured virtual audio device. Browser mode handles the embedded assistant separately.

Click **Stop audio** to release capture. If a device disappears or the audio graph stalls, capture ends and the avatar returns to idle. Reconnect the source, refresh the device list, and start again.

## Assistant browser mode

The default website is [Sesame](https://app.sesame.com). Account access, guest access, voice availability, and sign-in are controlled by the website.

1. Choose **Assistant browser** and open Sesame using the button beside the website address.
2. Click **Enable / refresh** to enumerate inputs in the assistant website's browser session.
3. Choose **Microphone sent to assistant**. Use a microphone or a source containing one speaker.
4. Save changes.
5. Click **Capture assistant audio**.
6. Start the website's voice conversation inside the embedded browser.

The selected microphone is supplied to ordinary top-level `getUserMedia` requests from the website. The app verifies the returned track's device ID and stops capture if it cannot confirm the selection. A **Verified input** label appears after the site successfully opens the selected source.

The avatar listens to audio from the embedded assistant tab. Its analyzer does not include the microphone input or unrelated desktop applications. The assistant remains audible through normal playback; use headphones if speaker playback could feed back into the microphone.

**Stop audio** stops analysis and reloads the assistant page to end its media tracks and voice connection. Changing the microphone requires reconnecting the site's voice session.

Custom assistant addresses may use HTTPS, or HTTP on localhost. Compatibility depends on the site's browser and media behavior. Voice capture from an iframe is deliberately denied. Google, Apple, or another identity provider may refuse an embedded browser; there is no private API integration, cookie transfer, or login bypass. If a website refuses access or uses an unsupported voice flow, its integration is unavailable until that flow is supported.

## Add the avatar to OBS

1. Keep Voxincarnate open and select a saved character.
2. Click **Copy OBS URL**.
3. In OBS, add a **Browser** source, leave **Local file** disabled, and paste the URL.
4. Set the Browser Source width and height to the character's canvas dimensions. Start with 30 FPS; 60 FPS is optional.
5. Position the source above your scene's other layers.

The URL has this form:

```text
http://127.0.0.1:48241/overlay/<character-id>?token=<local-access-token>
```

Character IDs, the access token, and the configured port persist across restarts. Edits refresh the source without changing its URL. The overlay shows only the avatar, with a transparent page background; builder controls, browser content, and diagnostics stay in the desktop application. It reconnects after interruptions and returns to a closed-mouth pose when input becomes stale.

The Browser Source is **video only**. For assistant sound, add OBS **Application Audio Capture** for Voxincarnate separately. For direct mode, capture the selected microphone/input separately in OBS. Ensure the same sound is not also included through another desktop or microphone source. See the official [Browser Source](https://obsproject.com/kb/browser-source) and [Application Audio Capture](https://obsproject.com/kb/application-audio-capture-guide) guides.

The overlay server listens only on `127.0.0.1`; it is intended for OBS on the same computer. Treat the copied URL as local access information. Close a second app instance if port 48241 is already in use. This release keeps the port fixed during a running session.

## Storage and privacy

Characters, settings, and managed image assets are stored in Electron's `userData` directory, normally `%APPDATA%\Voxincarnate` on Windows. Back up the whole application data directory to retain the library and its images. The assistant website has a separate persistent browser session.

Voxincarnate analyzes audio locally and sends only level/speaking state to its local overlay. It does not upload character images, record conversations, or forward raw audio to the overlay. In assistant mode, the microphone is sent to the selected website through that site's voice connection and is subject to its policies. Device discovery can briefly open and immediately close an input to obtain device labels.

Malformed library data is reported and preserved rather than silently replaced. A recovery copy is attempted beside `library.json`. Keep the original files when investigating a startup error.

## Development and Windows packages

```powershell
npm run check
npm run smoke
npm run pack
npm run dist
```

| Command | Purpose |
| --- | --- |
| `npm run check` | TypeScript checking, automated tests, and production build. |
| `npm run smoke` | Launch an Electron test profile and exercise a local oscillator through the embedded-tab capture path. Results are written under `.qa/`. |
| `npm run pack` | Build an unpacked Windows x64 application under `release/`. |
| `npm run dist` | Run checks and build Windows x64 NSIS installer and ZIP artifacts under `release/`. |
| `npm run preview` | Preview the frontend layout; desktop file access and embedded audio require Electron. |

Package creation requires access to Electron and electron-builder dependencies. Installer and ZIP output are distribution targets, not evidence of a clean installation or live assistant compatibility. This project has no automatic updater or bundled signing certificate; release signing requires separately configured credentials.

| Path | Responsibility |
| --- | --- |
| `desktop/main.ts` | Windows application, permissions, native image import, embedded browser, and desktop IPC. |
| `desktop/preload.ts` | Narrow bridge between the studio UI and native actions. |
| `desktop/renderer/` | Character library/builder, audio controls, assistant viewport, and OBS link. |
| `desktop/assistant-preload.ts`, `desktop/browser-adapter.ts` | Assistant-origin input discovery, selected-device adaptation, and bounded diagnostics. |
| `desktop/audio/` | Capture lifecycle, RMS AudioWorklet, and speech envelope detector. |
| `desktop/library.ts` | Managed artwork, schema validation, persistent identities, and atomic library saves. |
| `desktop/overlay.ts` | Authenticated local avatar HTTP/WebSocket output. |
| `desktop/tests/` | Audio lifecycle, detector, assistant adapter, storage, and overlay regressions. |

## Acceptance checks

Before using a release in a live stream:

- Import your own transparent closed/open PNGs, align them, save, restart, and confirm the same character and OBS URL return.
- Confirm silence stays closed, speech opens the mouth, brief pauses do not chatter, and Stop immediately returns to idle.
- In Sesame, verify the chosen physical input, start a real voice conversation, and confirm only assistant responses animate the avatar.
- Play unrelated desktop audio and confirm it does not animate the character in assistant mode.
- Composite the Browser Source over a contrasting OBS background, change scenes, hide/show the source, and restart Voxincarnate.
- Record an OBS clip and check alpha, mouth timing, assistant sound, and absence of doubled audio.
- Test the installer on a clean Windows 11 x64 user profile, including launch, restart, and retained user data.

Automated tests and the oscillator fixture cover different evidence from these real microphone, website, installation, and OBS checks. Consult the delivery's validation notes for checks actually performed.

## Legacy Python overlays

The original backend and overlays remain in `app.py`, `voxincarnate/voxincarnate.py`, and `overlays/`. They are separate from the desktop application:

```powershell
python -m pip install pyaudio websockets numpy
python app.py
```

Choose an input in the terminal, then open a legacy HTML overlay or add it as an OBS local-file Browser Source. These overlays use the original WebSocket service on port 5678 and retain the original behavior. They do not use the desktop character library or its OBS URL.

## License

[MIT](LICENSE).

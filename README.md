# Voxincarnate

Voxincarnate is a Windows desktop studio for talking avatars. Create a character kit from one reference image, optionally generate a new character with OpenAI, or build with your own artwork. Animate speech from an audio input or an embedded voice-assistant website, play walking entrances and exits, and add the transparent animation to OBS as a Browser Source.

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

Choose **New character** to open the creation suite. **Use an image** accepts one PNG or JPEG reference. A clear full-body character with a visible face works best; a cropped reference requires the model to imagine the missing body for walking artwork. Enter a name and optional style notes, review the speech area, then choose **Generate character kit**.

The optional **Generate a character** tab accepts a description instead. OpenAI develops a concept and creates its reference image before running the same animation pipeline.

Both paths prepare a draft with nine speech poses and closed/open fallbacks. For an imported image, use **Find face automatically** to locate the face, both eyes, and its associated mouth. Detection rejects uncertain or inconsistent landmarks, including a mouth outside the face, and shows both editable boxes before generation. Check that the mouth is on the face rather than a prop. **Choose mouth area** draws a manual selection without a vision request; **Adjust → Face** also supports a manual face selection.

**Mouth with a soft blend** is the default. **Natural face expressions** allows subtle cheek and brow changes inside the selected face; its mouth must be contained in that face. The generator receives a square facial context repeated in a fixed nine-cell template with an oval edit mask, preserving framing instead of stretching a tight mouth crop. The app matches modest color/lighting differences and blends a broad, soft oval into the source. The original canvas, alpha, and every pixel outside the selected speech area stay exact; X/rest is the original image. This local composition follows the preservation approach in the official [image prompting guide](https://developers.openai.com/api/docs/guides/image-prompting). For mouth mode select the lips plus surrounding skin; for face mode include brows, cheeks and chin while avoiding hair, neck and props. Mouth selections are limited to 25% of the image and face selections to 65%.

Before generation, choose each entrance/exit effect and walking direction. The default enters from the **right edge, moving left**, then exits through the **right edge, moving right**. **Exit through the same edge** links the defaults; turn it off to choose the exit edge independently. Choose walking, smoke appearance/disappearance, or fall-from-top/jump-through-top. Smoke and fall/jump animate the resting artwork locally and need no generated motion images. Only selected walking channels generate four-frame gait cycles.

Preview every mouth pose and both effects, adjust alignment and timing, then **Save changes**. Walking artwork is model output and still needs review. Generation never replaces a saved character automatically. Previously generated full-body mouth sets need regeneration from the original reference to gain pixel preservation; existing saved artwork is retained.

Generation uses `OPENAI_API_KEY` from the environment that launches the desktop app. The key remains in the Electron main process and is never sent to the studio renderer, assistant website, OBS, or library JSON. The default models are `gpt-4.1-mini` for the optional concept and `gpt-image-1.5` for transparent artwork; `OPENAI_TEXT_MODEL` and `OPENAI_IMAGE_MODEL` override them. Model/project access and API billing must be available. Requests follow the official [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), [image generation](https://developers.openai.com/api/reference/resources/images/methods/generate), and [image editing](https://developers.openai.com/api/reference/resources/images/methods/edit) contracts.

The image path makes one speech-edit request plus one edit per selected walking channel (zero to two). **Find face automatically** makes a separate vision request each time it is clicked; generating from reviewed selections reuses them. Manual selection skips vision. The description path additionally makes a concept request and a source-image request before automatic face/mouth detection. API charges apply. Cancel stops remaining steps and aborts the current local request; a request already sent may still be billed. Requests time out after four minutes each and are not automatically retried. Failed or cancelled generation does not save a partial character.

**Build manually with your own artwork** remains available without an API key:

1. Choose **New character**, then **Build manually with your own artwork**, or edit an existing character.
2. Enter a name and canvas dimensions.
3. Select **Closed mouth** and **Open mouth** in **Preview and edit artwork**, and add at least one image to each.
4. Select individual images to adjust their horizontal offset, vertical offset, and scale. Use **Move earlier** to change frame order and adjust the frame interval to control cycling.
5. Use **Save changes** in the top bar before starting audio.

Imports accept PNG and JPEG, up to 16 MB and 4096 pixels per dimension, with up to 24 files per import. A saved character supports up to 64 images per mouth pose. Imported files are decoded, normalized to PNG, and copied into application storage; moving the original files afterward does not break the character.

Use the trash button beside a character in the library to delete it, then confirm. Deleting removes its saved artwork from application storage and clears its connected OBS sources. Original imported files are untouched. If it was selected, the studio switches to another saved character. Keep at least one character in the library; add another before deleting the last one.

Use transparent PNGs for a cutout avatar. The overlay canvas is transparent, but opaque pixels already in an image remain visible. The bundled sample sprites retain their image backgrounds; the application does not automatically remove them. Images use their natural pixel dimensions, centered on the character canvas, with each frame's saved offset and scale.

Existing characters use **Closed / open** animation: audio energy selects a pose and cycles its supplied frames. **Lip sync · nine mouth poses** adds local, approximate audio-to-viseme detection and nine labeled mouth poses. Playback uses saved artwork; new drawings are generated only through an explicit creation-suite action.

### Walking entrances and exits

The builder's **Entrance and exit** section chooses effects, edges, and durations for saved or manually built characters. Select the walking channel in the artwork picker to import, reorder, remove, and align gait frames. **Walking artwork faces** declares the supplied orientation; playback mirrors it to match movement. The app measures nontransparent sprite bounds and the actual viewport, so visible artwork starts immediately beyond the selected frame edge instead of crossing a blank margin inside the character canvas. Supply a repeating gait with a consistent scale and foot baseline.

**Walk in / Walk out** or **Preview entrance / Preview exit** below the preview affect only the studio. After saving, **Enter OBS** and **Exit OBS** control the live overlay. An exit keeps the character hidden until the next entrance; starting or stopping speech does not change visibility. Presence lasts for the app session, and the app starts with characters visible after relaunch. Mouth animation resumes when an entrance completes. Walking uses managed PNG sprite sequences; smoke and fall/jump use shared procedural playback, with a transparent smoke canvas. These are not exported movie files.

### Sound-specific mouth animation

Choose **Try lip-sync demo** to add Signal, a transparent character with all nine mouth poses. Close the builder and start audio to try it. Existing characters stay in their original mode.

For your own character, open the builder, choose **Lip sync · nine mouth poses**, and import aligned images for A through H and X. Each pose shows its sound description and can be previewed in the builder. Keep the canvas, face, and upper teeth aligned across images. Use transparent PNGs if you need a cutout. Missing poses use the character's closed/open artwork, and the builder reports how many poses are ready. See the [mouth artwork and timing guide](docs/lip-sync.md).

Preview and OBS share the same elapsed-time pose selection. Wide openings pass through the medium-open C pose; P/B/M closures can occur while the voice remains active. This is image-based animation, so authored poses determine how fluidly the mouth moves.

The bundled HeadAudio model analyzes audio locally with no account or remote inference service. Its predictions are approximate, particularly with noise, music, or unfamiliar voices. If the analyzer cannot load or stops, the application shows a diagnostic and continues using closed/open animation. Normal assistant playback is preserved; no compensating audio delay is added.

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

Voxincarnate analyzes audio locally and sends level/speaking state, estimated mouth-pose weights, and entrance/exit state to its local overlay. It does not record conversations or forward raw audio to the overlay. Explicit AI generation uploads your selected reference image and/or design description to OpenAI; manual creation and normal animation do not upload artwork. In assistant mode, the microphone is sent to the selected website through that site's voice connection and is subject to its policies. Device discovery can briefly open and immediately close an input to obtain device labels.

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
| `desktop/character-generation.ts` | Main-process OpenAI concept/image generation, bounded requests, cancellation, and safe errors. |
| `desktop/animation.ts` | Shared speech selection and entrance/exit playback for studio and OBS. |
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

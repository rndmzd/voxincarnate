# Local control API, version 1

Voxincarnate exposes a separate authenticated API on `127.0.0.1:48242` by default. Configure the port or disable it in **Stream Deck & hotkeys**. The original OBS overlay HTTP/WebSocket service stays read-only and uses a different token. Disabling the API does not disable global hotkeys.

**Copy connection code** supplies JSON with `port` and `token`. All API requests, including WebSocket upgrades, require `Authorization: Bearer <token>`. Query-string tokens, foreign Host headers, and browser Origin/Fetch-Site headers are rejected. This API is for native local clients; it does not offer browser CORS access. It exposes no artwork paths, API keys, OBS credentials, arbitrary script execution, deletion, or generation actions.

## Endpoints

| Method | Route | Result |
| --- | --- | --- |
| GET | `/v1/status` | Current `ControlState`. |
| POST | `/v1/commands` | A command result and the resulting state. Requires `Content-Type: application/json`. Maximum body 4096 bytes. |
| WebSocket | `/v1/events` | An initial state snapshot, then `{ "type": "state", "state": ... }` updates. Client messages close this read-only subscription. |

Successful commands return HTTP 200 with `{ "ok": true, "state": ... }`. Unavailable/failed actions return 409 with `{ "ok": false, "code": "...", "message": "...", "state": ... }`. Bad commands return 400; missing/invalid authentication returns 403; incorrect content type returns 415; oversized bodies return 413. Unsupported routes return 404. The server does not redirect requests.

State includes `apiVersion`, `revision`, `ready`, `busy`, `dirty`, `running`, `mode`, `activeCharacterId`, `selectedInputId`, `inputs`, and `characters`. Each character has `id`, `name`, `visible`, and available `motions.enter`/`motions.exit` arrays. Availability reflects saved artwork. A fresh connection always receives current state and never replays animations. `visible` is the requested presence state; it does not report whether OBS itself is running or displaying the source.

## Commands

```json
{ "action": "audio.start" }
{ "action": "audio.stop" }
{ "action": "audio.toggle" }
{ "action": "inputs.refresh" }
{ "action": "character.enter", "effect": "walk" }
{ "action": "character.exit", "effect": "smoke", "characterId": "saved-character-uuid" }
```

The `characterId` example is a placeholder; supply an actual UUID from status. Only animation actions accept `characterId` and `effect`. Omit `characterId` to use the studio's currently selected character. Effects are `walk`, `fall-jump`, or `smoke`. Omit `effect` to use the character's active saved entrance/exit, including an immediate show/hide when no animation is configured. A command never changes the saved default.

`audio.start` uses the selected studio audio mode and input. It is idempotent when capture is already active. `audio.stop` is idempotent and can interrupt pending startup. `audio.toggle` uses current capture state. Assistant capture analyzes the embedded website; it does not sign in, start its voice call, record audio to a file, or add assistant sound to OBS. Existing isolated assistant-tab permissions and audio routing remain in force.

`inputs.refresh` waits for discovery in the current audio mode. It can request microphone permission and return updated device labels. Refresh requires stopped audio. Missing/invalid input selections must be chosen and saved in the studio. Unsaved changes block capture startup and animation commands. Specific-character animation commands also respect that guard. Unsupported animations are rejected; there is no fallback to another effect.

Non-stop commands are rejected while the studio is busy. Presses are not queued. Stop remains available. A command response confirms completion of the app action, not completion of a visual animation or a physical OBS check. After 20 seconds, an unfinished command returns `timeout`; the pending operation still blocks other non-stop commands until it settles. Check the studio before retrying. The Stream Deck client reconnects its state subscription with backoff but never resends a command automatically.

## PowerShell example

After copying the connection code from the app:

```powershell
$voxConnection = Get-Clipboard | ConvertFrom-Json
$voxHeaders = @{ Authorization = "Bearer $($voxConnection.token)" }
$voxBase = "http://127.0.0.1:$($voxConnection.port)"
Invoke-RestMethod "$voxBase/v1/status" -Headers $voxHeaders
Invoke-RestMethod "$voxBase/v1/commands" -Method Post -Headers $voxHeaders -ContentType 'application/json' -Body '{"action":"character.enter","effect":"smoke"}'
```

Treat the copied connection code as a password. It remains in `controls.json` in the Windows user's app-data folder and in Stream Deck's plugin global settings. The studio exposes it only to its trusted local renderer for copying. Changing the port requires copying a fresh code. No network-wide binding is supported.

## Implementation and verification

`desktop/control-protocol.ts` validates commands/settings and defines common guards. `desktop/controls.ts` dispatches validated commands to the trusted studio entry point, maintains state, and manages transactional shortcut/port changes. The UI, API, plugin, and global hotkeys invoke that command path. The Electron entry point supplies an explicit user gesture to its fixed trusted-renderer command call so background assistant capture can use the existing capture API.

`desktop/control-server.ts` implements authenticated HTTP and state subscriptions. `streamdeck/src/` contains the official Elgato SDK plugin, local HTTP/WebSocket client, and key presentation. `scripts/build-streamdeck.mjs` bundles it and uses Elgato's CLI to validate/package the installer, including runtime license notices. The installer is bundled with the Windows app; it is not automatically installed or published to Elgato Marketplace.

Run `npm run check`, `npm run smoke:controls`, and `npm run smoke:streamdeck`. The smoke tests use an isolated app-data profile, fake microphone/local tone, and a simulated Stream Deck host. Real hardware presses, physical microphone routing, website voice calls, OBS output, and clean-machine installation require their own checks.
